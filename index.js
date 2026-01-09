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

// --- SYSTÈME DE CACHE RAPIDE (Pour imiter Wazzap AI) ---
// On garde les données en mémoire pour aller vite, on ne sauvegarde que l'essentiel
const memoryCache = new Map();

const useSupabaseAuth = async (sessionId) => {
    // Fonction d'écriture avec délai (Debounce) pour éviter de saturer Supabase
    const writeData = async (data, key) => {
        try {
            // On met à jour le cache immédiat
            memoryCache.set(`${sessionId}-${key}`, data);
            
            // On envoie à Supabase
            await supabase.from('whatsapp_sessions').upsert({ 
                session_id: sessionId, 
                key_id: key, 
                data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) 
            });
        } catch (e) {
            // Erreur silencieuse pour ne pas bloquer le flux
        }
    };

    const readData = async (key) => {
        try {
            // On regarde d'abord dans le cache rapide
            if (memoryCache.has(`${sessionId}-${key}`)) {
                return memoryCache.get(`${sessionId}-${key}`);
            }
            // Sinon on regarde dans Supabase
            const { data, error } = await supabase.from('whatsapp_sessions').select('data').eq('session_id', sessionId).eq('key_id', key).single();
            if (error && error.code !== 'PGRST116') return null;
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
    console.log(`🚀 Démarrage session TURBO : ${instanceId}`);
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            // 👇 CONFIGURATION MIMÉTIQUE "DESKTOP" (Le plus compatible) 👇
            browser: ["Mac OS", "Desktop", "10.15.7"], 
            
            // 👇 OPTIMISATIONS DE VITESSE 👇
            syncFullHistory: false,        // Ne pas télécharger l'historique (Gain de 10s)
            printQRInTerminal: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,    // Ping rapide pour garder la ligne ouverte
            emitOwnEvents: true,
            fireInitQueries: false,        // Accélère le démarrage
            generateHighQualityLinkPreview: false,
            
            // Ignore les messages de groupe/statuts pour aller plus vite au début
            shouldIgnoreJid: jid => isJidBroadcast(jid),

            getMessage: async (key) => { return { conversation: 'Hello' }; },
        });

        if (phoneNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`📞 Demande code pour : ${cleanPhone}`);
                    const code = await sock.requestPairingCode(cleanPhone);
                    console.log(`🔑 CODE REÇU : ${code}`);
                    // Mise à jour Rapide
                    await supabase.from('instances').update({ qr_code: code, status: 'pairing_code' }).eq('id', instanceId);
                } catch (err) { console.error("❌ Erreur code:", err.message); }
            }, 3000); // Délai réduit à 3s car le mode Turbo est prêt plus vite
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !phoneNumber) {
                await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            }
            
            if (connection === 'open') {
                console.log(`✅ CONNECTÉ ! (Sauvegarde finale...)`);
                // Une fois connecté, on s'assure que tout est bien écrit
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401 && statusCode !== 403;
                
                if (shouldReconnect) startWhatsApp(instanceId, phoneNumber);
                else {
                    await supabase.from('instances').update({ status: 'disconnected', qr_code: null }).eq('id', instanceId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (e) { console.error("🚨 Erreur fatale:", e); }
};

app.get('/', (req, res) => res.send('Worker Turbo Ready 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'ID manquant' });

    console.log(`🔄 Nettoyage Rapide pour ${instanceId}`);
    try {
        // On nettoie le cache mémoire local
        memoryCache.clear();
        await supabase.from('whatsapp_sessions').delete().eq('session_id', instanceId);
        await supabase.from('instances').update({ qr_code: null, status: 'initializing' }).eq('id', instanceId);
    } catch (e) {}

    startWhatsApp(instanceId, phoneNumber).catch(e => console.error(e));
    return res.json({ status: 'started' });
});

app.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));
