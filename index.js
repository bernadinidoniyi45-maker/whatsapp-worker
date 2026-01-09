const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ ERREUR : Les variables SUPABASE_URL ou SUPABASE_KEY manquent !");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// --- GESTION DE L'AUTHENTIFICATION SUPABASE ---
const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => {
        try {
            const { error } = await supabase
                .from('whatsapp_sessions')
                .upsert({ 
                    session_id: sessionId, 
                    key_id: key, 
                    data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) 
                });
            if (error) console.error(`Erreur écriture (${key}):`, error.message);
        } catch (e) {
            console.error(`Erreur critique écriture (${key}):`, e);
        }
    };

    const readData = async (key) => {
        try {
            const { data, error } = await supabase
                .from('whatsapp_sessions')
                .select('data')
                .eq('session_id', sessionId)
                .eq('key_id', key)
                .single();
            
            if (error && error.code !== 'PGRST116') return null;
            return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
        } catch (e) {
            return null;
        }
    };

    const removeData = async (key) => {
        try {
            await supabase.from('whatsapp_sessions').delete().eq('session_id', sessionId).eq('key_id', key);
        } catch (e) {
            console.error(`Erreur suppression (${key}):`, e);
        }
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

// --- COEUR DU ROBOT WHATSAPP ---
const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`🚀 Démarrage session : ${instanceId} (Mode: ${phoneNumber ? 'Code Tel' : 'QR Scan'})`);
    
    try {
        const { state, saveCreds } = await useSupabaseAuth(instanceId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            
            // 👇 PROTECTION CRITIQUE 👇
            browser: ["Ubuntu", "Chrome", "20.0.04"], // Anti-401
            syncFullHistory: false,                   // Anti-Crash Render
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
        });

        // --- CODE DE JUMELAGE ---
        if (phoneNumber && !sock.authState.creds.registered) {
            console.log("⏳ Attente 4s avant demande du code...");
            
            setTimeout(async () => {
                try {
                    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`📞 Demande envoyée pour : ${cleanPhone}`);
                    
                    const code = await sock.requestPairingCode(cleanPhone);
                    
                    console.log(`------------------------------------------------`);
                    console.log(`🔑 TON CODE : ${code}`);
                    console.log(`------------------------------------------------`);

                    await supabase.from('instances')
                        .update({ qr_code: code, status: 'pairing_code' })
                        .eq('id', instanceId);

                } catch (err) {
                    console.error("❌ ÉCHEC Pairing Code:", err.message);
                }
            }, 4000); 
        }

        // --- ÉVÉNEMENTS ---
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !phoneNumber) {
                console.log("⚡ QR Code généré");
                await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            }

            if (connection === 'open') {
                console.log(`✅ CONNECTÉ : ${instanceId}`);
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401; // On évite la boucle infinie sur 401
                
                console.log(`❌ Déconnexion (Code: ${statusCode}). Reconnexion : ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    startWhatsApp(instanceId, phoneNumber);
                } else {
                    console.log("⚠️ Session fermée ou corrompue.");
                    await supabase.from('instances').update({ status: 'disconnected' }).eq('id', instanceId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (e) {
        console.error("🚨 Erreur fatale startWhatsApp:", e);
    }
};

// --- ROUTES API ---
app.get('/', (req, res) => res.send('WhatsApp Worker Ready 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    
    if (!instanceId) return res.status(400).json({ error: 'Instance ID manquant' });

    console.log(`🔄 Nouvelle demande pour ${instanceId}. Nettoyage en cours...`);

    // 👇 NETTOYAGE AUTOMATIQUE (Plus besoin de le faire à la main !) 👇
    try {
        // On supprime les anciennes sessions pour cet ID
        await supabase.from('whatsapp_sessions').delete().eq('session_id', instanceId);
        // On remet la ligne instance à neuf
        await supabase.from('instances').delete().eq('id', instanceId); 
        
        // (Optionnel) Recréer la ligne instance propre tout de suite
        await supabase.from('instances').insert([{ id: instanceId, status: 'initializing' }]);
        
        console.log("✨ Nettoyage terminé.");
    } catch (e) {
        console.error("Info nettoyage:", e.message); // Pas grave si ça échoue
    }

    // On lance le processus
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error("Erreur init:", e));

    return res.json({ 
        status: 'initializing', 
        message: 'Démarrage propre en cours...' 
    });
});

app.listen(PORT, () => console.log(`🚀 Serveur sur port ${PORT}`));
