const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// --- GESTION SUPABASE (Ne pas toucher) ---
const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => {
        try {
            await supabase.from('whatsapp_sessions').upsert({ 
                session_id: sessionId, 
                key_id: key, 
                data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) 
            });
        } catch (e) { console.error(`Erreur écriture ${key}`, e); }
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

// --- LE CŒUR DU SYSTÈME ---
const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`🚀 Démarrage session : ${instanceId}`);
    
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            
            // 👇 ICI C'EST LA PROTECTION ANTI-BLOCAGE 401 👇
            browser: ["Ubuntu", "Chrome", "20.0.04"], 
            syncFullHistory: false, // Vital pour Render Gratuit
            connectTimeoutMs: 60000,
        });

        // Gestion du Code de Jumelage (Pairing Code)
        if (phoneNumber && !sock.authState.creds.registered) {
            console.log("⏳ Attente initialisation...");
            setTimeout(async () => {
                try {
                    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`📞 Demande code pour : ${cleanPhone}`);
                    
                    const code = await sock.requestPairingCode(cleanPhone);
                    console.log(`🔑 CODE REÇU : ${code}`); // REGARDE ICI DANS LES LOGS

                    await supabase.from('instances')
                        .update({ qr_code: code, status: 'pairing_code' })
                        .eq('id', instanceId);
                        
                } catch (err) {
                    console.error("❌ Erreur Code:", err.message);
                }
            }, 5000); // 5 secondes de délai pour être sûr
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !phoneNumber) {
                console.log("⚡ QR Code généré");
                await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            }

            if (connection === 'open') {
                console.log(`✅ ${instanceId} EST CONNECTÉ !`);
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }

            if (connection === 'close') {
                const code = (lastDisconnect.error)?.output?.statusCode;
                // Si erreur 401 (Unauthorized), on ne reconnecte pas automatiquement pour éviter la boucle
                const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 401;
                
                console.log(`❌ Déconnexion (Code ${code}). Reconnexion : ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    startWhatsApp(instanceId, phoneNumber);
                } else if (code === 401) {
                    console.error("⛔ SESSION CORROMPUE (401). IL FAUT VIDER SUPABASE !");
                    await supabase.from('instances').update({ status: 'error_401' }).eq('id', instanceId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (e) {
        console.error("Erreur fatale:", e);
    }
};

// --- ROUTES ---
app.get('/', (req, res) => res.send('Worker en ligne 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'instanceId manquant' });

    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));
    return res.json({ status: 'started' });
});

app.listen(PORT, () => console.log(`Port ${PORT}`));
