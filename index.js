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
        } catch (e) {
            // On ignore les erreurs mineures d'écriture
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

// --- COEUR DU ROBOT WHATSAPP ---
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
            
            // 👇 CONFIGURATION ANTI-CRASH & ANTI-BAN 👇
            browser: ["Ubuntu", "Chrome", "20.0.04"], // Important pour éviter Erreur 401
            syncFullHistory: false,                   // Important pour éviter le crash mémoire
            generateHighQualityLinkPreview: false,    // Économie CPU
            connectTimeoutMs: 60000,                  // Délai étendu pour éviter Erreur 408
            
            // Astuce pour éviter le crash sur les vieux messages
            getMessage: async (key) => {
                return { conversation: 'Hello' };
            },
        });

        // --- CODE DE JUMELAGE (PAIRING CODE) ---
        if (phoneNumber && !sock.authState.creds.registered) {
            console.log("⏳ Préparation du code...");
            
            setTimeout(async () => {
                try {
                    // Nettoyage du numéro
                    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`📞 Demande envoyée pour : ${cleanPhone}`);
                    
                    const code = await sock.requestPairingCode(cleanPhone);
                    
                    console.log(`🔑 CODE REÇU : ${code}`);

                    // Sauvegarde dans Supabase
                    await supabase.from('instances')
                        .update({ qr_code: code, status: 'pairing_code' })
                        .eq('id', instanceId);

                } catch (err) {
                    console.error("❌ Échec demande code:", err.message);
                }
            }, 4000); 
        }

        // --- ÉVÉNEMENTS ---
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Gestion QR (si pas de tel)
            if (qr && !phoneNumber) {
                await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            }

            // Connexion Réussie
            if (connection === 'open') {
                console.log(`✅ SUCCÈS : ${instanceId} Connecté !`);
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }

            // Déconnexion / Erreur
            if (connection === 'close') {
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                
                // On ne reconnecte PAS si c'est 401 (Banni) ou 403 (Logout) pour éviter la boucle infinie
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401 && statusCode !== 403;
                
                console.log(`❌ Déconnexion (Code: ${statusCode}). Retry : ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    startWhatsApp(instanceId, phoneNumber);
                } else {
                    // Si c'est une erreur fatale, on marque comme déconnecté
                    await supabase.from('instances').update({ status: 'disconnected' }).eq('id', instanceId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (e) {
        console.error("🚨 Erreur fatale:", e);
    }
};

// --- ROUTES API ---
app.get('/', (req, res) => res.send('Worker is Running 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    
    if (!instanceId) return res.status(400).json({ error: 'Instance ID manquant' });

    console.log(`🔄 Nouvelle demande pour ${instanceId}`);

    // 👇 LE NETTOYAGE AUTOMATIQUE EST ICI 👇
    // Plus besoin de le faire manuellement !
    try {
        // 1. On supprime les anciennes données de session
        await supabase.from('whatsapp_sessions').delete().eq('session_id', instanceId);
        // 2. On supprime l'état de l'instance
        await supabase.from('instances').delete().eq('id', instanceId); 
        
        console.log("🧹 Nettoyage automatique effectué.");
    } catch (e) {
        console.error("Erreur nettoyage (ignorable):", e.message);
    }
    // 👆 FIN DU NETTOYAGE 👆

    // On lance le processus propre
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error("Erreur init:", e));

    return res.json({ 
        status: 'initializing', 
        message: 'Démarrage...' 
    });
});

app.listen(PORT, () => console.log(`🚀 Serveur sur port ${PORT}`));
