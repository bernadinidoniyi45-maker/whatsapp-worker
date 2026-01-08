const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const pino = require('pino');

// --- CONFIGURATION ---
// Sur Render, ces variables doivent être dans "Environment Variables"
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // IMPORTANT: Utiliser la clé "service_role"
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("ERREUR: Variables SUPABASE manquantes.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();
app.use(express.json());

// --- 1. ADAPTATEUR SUPABASE (Sauvegarde la session dans la DB) ---
const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({ session_id: sessionId, key_id: key, data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) });
        if (error) console.error('Erreur sauvegarde:', error.message);
    };

    const readData = async (key) => {
        const { data } = await supabase
            .from('whatsapp_sessions')
            .select('data')
            .eq('session_id', sessionId)
            .eq('key_id', key)
            .single();
        return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
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
                            // Fix spécifique pour Baileys
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

// --- 2. LOGIQUE WHATSAPP ---
const startWhatsApp = async (instanceId) => {
    console.log(`Démarrage session pour: ${instanceId}`);
    const { state, saveCreds } = await useSupabaseAuth(instanceId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ["Mon SaaS Automation", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("QR Code reçu. Envoi à la DB...");
            await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
        }

        if (connection === 'open') {
            console.log(`✅ ${instanceId} est connecté !`);
            await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Déconnexion ${instanceId}. Reconnexion: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                startWhatsApp(instanceId);
            } else {
                await supabase.from('instances').update({ status: 'disconnected', qr_code: null }).eq('id', instanceId);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
};

// --- 3. SERVEUR HTTP (Pour Lovable & UptimeRobot) ---

// Route pour UptimeRobot (Empêche Render de dormir)
app.get('/', (req, res) => {
    res.send('WhatsApp Worker is Running 🚀');
});

// Route déclenchée par Lovable
app.post('/init-session', async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'instanceId required' });
    
    // On lance le processus sans attendre (fire & forget)
    startWhatsApp(instanceId).catch(err => console.error(err));
    
    return res.json({ status: 'initializing', message: 'Démarrage en cours...' });
});

app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
