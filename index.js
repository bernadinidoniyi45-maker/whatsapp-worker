const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState, isJidBroadcast } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY; // Ta clé configurée dans Render
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// --- FONCTION POUR PARLER À GROQ (L'INTELLIGENCE) ---
async function askGroqAI(userMessage) {
    if (!GROQ_API_KEY) return "⚠️ Erreur : La clé API Groq n'est pas configurée dans Render.";

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama3-70b-8192", // Modèle rapide et intelligent
                messages: [
                    {
                        role: "system",
                        content: "Tu es HOSTILEGOT DIGITAL, un assistant virtuel IA utile, sympathique et professionnel. Tu tutoies l'utilisateur si l'ambiance est décontractée. Tu es là pour aider, répondre aux questions et discuter. Tes réponses sont concises et claires pour WhatsApp."
                    },
                    {
                        role: "user",
                        content: userMessage
                    }
                ],
                temperature: 0.7,
                max_tokens: 300
            })
        });

        const data = await response.json();
        return data.choices?.[0]?.message?.content || "Désolé, je suis un peu fatigué (Erreur IA).";

    } catch (error) {
        console.error("Erreur Groq:", error);
        return "Une erreur technique m'empêche de répondre pour l'instant.";
    }
}

// --- GESTION DE LA SESSION WHATSAPP ---
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

const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`🚀 Démarrage HOSTILEGOT DIGITAL : ${instanceId}`);
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ["Mac OS", "Chrome", "10.15.7"], 
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid) || jid.includes('status'),
            getMessage: async (key) => { return { conversation: 'Hello' }; },
        });

        // --- 🤖 LE CERVEAU IA EST ICI ---
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.key.fromMe) {
                    const sender = msg.key.remoteJid;
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                    if (text) {
                        console.log(`📩 Question reçue : ${text}`);
                        
                        // Simulation "En train d'écrire..." pour faire humain
                        await sock.sendPresenceUpdate('composing', sender);

                        // On demande la réponse à l'IA Groq
                        const aiResponse = await askGroqAI(text);
                        
                        console.log(`🤖 Réponse IA : ${aiResponse}`);

                        // On envoie la réponse
                        await sock.sendMessage(sender, { text: aiResponse });
                    }
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !phoneNumber) {
                await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            }
            if (connection === 'open') {
                console.log(`✅ CONNECTÉ !`);
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startWhatsApp(instanceId, phoneNumber);
                else await supabase.from('instances').update({ status: 'disconnected', qr_code: null }).eq('id', instanceId);
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (e) { console.error("🚨 Erreur fatale:", e); }
};

app.get('/', (req, res) => res.send('HOSTILEGOT AI Ready 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));
    return res.json({ status: 'started' });
});

app.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));
