const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState, isJidBroadcast } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

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
    console.log(`🚀 Démarrage session PRO : ${instanceId}`);
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
            shouldIgnoreJid: jid => isJidBroadcast(jid) || jid.includes('status'), // Ignore les statuts/stories
            getMessage: async (key) => { return { conversation: 'Hello' }; },
        });

        // --- 🧠 CERVEAU INTELLIGENT ---
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.key.fromMe) { // Ignore mes propres messages
                    const sender = msg.key.remoteJid;
                    console.log(`📩 Message reçu de ${sender}`);

                    try {
                        // 1. DÉTECTION DU CONTENU
                        const isText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                        const isImage = msg.message?.imageMessage;
                        const isAudio = msg.message?.audioMessage;

                        if (isText) {
                            console.log(`💬 Texte : ${isText}`);
                            // Réponse au texte
                            await sock.sendMessage(sender, { text: `🤖 J'ai bien reçu ton message : "${isText}"` });
                        } 
                        else if (isImage) {
                            console.log(`📷 Image reçue`);
                            // Réponse à l'image
                            await sock.sendMessage(sender, { text: "🤖 Wow, belle photo ! Je l'ai bien reçue." });
                        }
                        else if (isAudio) {
                            console.log(`🎤 Audio reçu`);
                            await sock.sendMessage(sender, { text: "🤖 J'ai bien reçu ton vocal." });
                        }

                    } catch (error) {
                        console.error("❌ Erreur réponse:", error);
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

app.get('/', (req, res) => res.send('Chatbot Pro Ready 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));
    return res.json({ status: 'started' });
});

app.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));
