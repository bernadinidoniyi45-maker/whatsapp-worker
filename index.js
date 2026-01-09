const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState, isJidBroadcast } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// 1. FONCTION : MODE INTELLIGENCE ARTIFICIELLE (GROQ) 🧠
// ============================================================
async function askGroqAI(userMessage, systemPrompt) {
    if (!GROQ_API_KEY) return "⚠️ Erreur : Clé API Groq non configurée.";

    // Si le client n'a pas mis de prompt, on met un défaut sympa
    const finalPrompt = systemPrompt || "Tu es un assistant virtuel utile, concis et professionnel sur WhatsApp.";

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama3-70b-8192", // Modèle très performant
                messages: [
                    { role: "system", content: finalPrompt },
                    { role: "user", content: userMessage }
                ],
                temperature: 0.7,
                max_tokens: 400
            })
        });

        const data = await response.json();
        return data.choices?.[0]?.message?.content || null;

    } catch (error) {
        console.error("❌ Erreur Groq:", error.message);
        return null;
    }
}

// ============================================================
// 2. FONCTION : MODE WEBHOOK (PASSERELLE VERS SITE CLIENT) 📡
// ============================================================
async function sendToUserWebhook(webhookUrl, messageData) {
    console.log(`📡 Envoi vers le Webhook : ${webhookUrl}`);
    try {
        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(messageData)
        });
        
        const data = await response.json();
        // Le webhook doit renvoyer un JSON : { "reply": "Le texte de réponse" }
        return data.reply || null;

    } catch (error) {
        console.error(`❌ Le webhook du client ne répond pas : ${error.message}`);
        return null;
    }
}

// ============================================================
// 3. GESTION DES SESSIONS (SAUVEGARDE DANS SUPABASE) 💾
// ============================================================
const memoryCache = new Map();

const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => {
        try {
            memoryCache.set(`${sessionId}-${key}`, data);
            await supabase.from('whatsapp_sessions').upsert({ 
                session_id: sessionId, 
                key_id: key, 
                data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) 
            });
        } catch (e) {}
    };

    const readData = async (key) => {
        try {
            if (memoryCache.has(`${sessionId}-${key}`)) return memoryCache.get(`${sessionId}-${key}`);
            const { data } = await supabase.from('whatsapp_sessions').select('data').eq('session_id', sessionId).eq('key_id', key).single();
            return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
        } catch (e) { return null; }
    };

    const removeData = async (key) => {
        try { 
            memoryCache.delete(`${sessionId}-${key}`);
            await supabase.from('whatsapp_sessions').delete().eq('session_id', sessionId).eq('key_id', key); 
        } catch (e) {}
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};

// ============================================================
// 4. LE CŒUR DU ROBOT (LOGIQUE PRINCIPALE) 🤖
// ============================================================
const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`🚀 Démarrage Instance SaaS : ${instanceId}`);
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ["SaaS Agent", "Chrome", "10.0"], 
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid) || jid.includes('status'),
            getMessage: async (key) => { return { conversation: 'Hello' }; },
        });

        // --- GESTION DES MESSAGES ENTRANTS ---
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.key.fromMe) {
                    const sender = msg.key.remoteJid;
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                    if (text) {
                        console.log(`📩 Message reçu pour ${instanceId}: ${text}`);
                        await sock.sendPresenceUpdate('composing', sender);

                        // A. ON CHERCHE LA CONFIGURATION DU CLIENT DANS SUPABASE
                        let config = { system_prompt: null, webhook_url: null };
                        try {
                            const { data } = await supabase
                                .from('instances')
                                .select('system_prompt, webhook_url')
                                .eq('id', instanceId)
                                .single();
                            if (data) config = data;
                        } catch (e) { console.error("Erreur lecture config DB"); }

                        let replyText = null;

                        // B. CHOIX DU MODE (WEBHOOK OU IA)
                        if (config.webhook_url) {
                            // --- MODE 1 : WEBHOOK (Le client gère tout) ---
                            console.log(`🔀 Mode Webhook détecté pour ${instanceId}`);
                            replyText = await sendToUserWebhook(config.webhook_url, {
                                event: "message",
                                instance_id: instanceId,
                                from: sender,
                                body: text
                            });
                        } else {
                            // --- MODE 2 : INTELLIGENCE ARTIFICIELLE (Par défaut) ---
                            console.log(`🧠 Mode IA Groq activé pour ${instanceId}`);
                            replyText = await askGroqAI(text, config.system_prompt);
                        }

                        // C. ENVOI DE LA RÉPONSE
                        if (replyText) {
                            await sock.sendMessage(sender, { text: replyText });
                            console.log(`📤 Réponse envoyée à ${sender}`);
                        }
                    }
                }
            }
        });

        // --- GESTION DE LA CONNEXION ---
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Mise à jour du QR Code pour le frontend
            if (qr && !phoneNumber) {
                console.log("📸 Nouveau QR Code généré");
                await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            }
            
            // Connecté
            if (connection === 'open') {
                console.log(`✅ ${instanceId} EST CONNECTÉ !`);
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }
            
            // Déconnecté (Tentative de reconnexion)
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ Déconnexion ${instanceId}. Reconnexion : ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    startWhatsApp(instanceId, phoneNumber);
                } else {
                    await supabase.from('instances').update({ status: 'disconnected', qr_code: null }).eq('id', instanceId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (e) { console.error("🚨 Erreur fatale:", e); }
};

// --- SERVEUR EXPRESS ---
app.get('/', (req, res) => res.send('SaaS WhatsApp Engine Running 🟢'));

// Endpoint appelé par ton site Lovable pour lancer un robot
app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    
    if (!instanceId) return res.status(400).json({ error: "Instance ID manquant" });

    // On lance le processus en arrière-plan
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));
    
    return res.json({ status: 'started', message: `Démarrage de l'agent ${instanceId}` });
});

app.listen(PORT, () => console.log(`Serveur SaaS prêt sur le port ${PORT}`));
