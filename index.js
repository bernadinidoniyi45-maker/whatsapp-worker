const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState } = require('@whiskeysockets/baileys');
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

const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => {
        try {
            await supabase.from('whatsapp_sessions').upsert({ 
                session_id: sessionId, 
                key_id: key, 
                data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) 
            });
        } catch (e) { /* On ignore les petites erreurs d'écriture */ }
    };

    const readData = async (key) => {
        try {
            const { data } = await supabase.from('whatsapp_sessions').select('data').eq('session_id', sessionId).eq('key_id', key).single();
            return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
        } catch (e) { return null; }
    };

    const removeData = async (key) => {
        await supabase.from('whatsapp_sessions').delete().eq('session_id', sessionId).eq('key_id', key);
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
    console.log(`🚀 Session: ${instanceId}`);
    
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ["Ubuntu", "Chrome", "20.0.04"], 
            syncFullHistory: false,
            generateHighQualityLinkPreview: false, // Économise le CPU
            markOnlineOnConnect: false,            // Reste discret
            connectTimeoutMs: 60000,
            // 👇 L'ASTUCE ANTI-CRASH EST ICI 👇
            // On empêche le serveur de chercher de vieux messages qui font planter la mémoire
            getMessage: async (key) => {
                return { conversation: 'Hello' };
            },
        });

        if (phoneNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`📞 Code pour : ${cleanPhone}`);
                    const code = await sock.requestPairingCode(cleanPhone);
                    console.log(`🔑 CODE : ${code}`);
                    await supabase.from('instances').update({ qr_code: code, status: 'pairing_code' }).eq('id', instanceId);
                } catch (err) { console.error("Err Code:", err.message); }
            }, 5000);
        }

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
                const code = (lastDisconnect.error)?.output?.statusCode;
                // On ne reconnecte PAS si c'est une erreur 401 (Banni) ou 403 (Logout)
                const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 401 && code !== 403;
                
                console.log(`❌ Close (${code}). Retry: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    startWhatsApp(instanceId, phoneNumber);
                } else {
                    await supabase.from('instances').update({ status: 'disconnected' }).eq('id', instanceId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (e) { console.error("Fatal:", e); }
};

app.get('/', (req, res) => res.send('Ready 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'ID manquant' });

    // Nettoyage Auto
    try {
        await supabase.from('whatsapp_sessions').delete().eq('session_id', instanceId);
        await supabase.from('instances').delete().eq('id', instanceId); 
    } catch (e) {}

    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));
    return res.json({ status: 'initializing' });
});

app.listen(PORT, () => console.log(`Port ${PORT}`));

