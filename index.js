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
    // Fonction pour écrire dans la DB
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

    // Fonction pour lire depuis la DB
    const readData = async (key) => {
        try {
            const { data, error } = await supabase
                .from('whatsapp_sessions')
                .select('data')
                .eq('session_id', sessionId)
                .eq('key_id', key)
                .single();
            
            if (error && error.code !== 'PGRST116') { // Ignorer erreur "non trouvé"
                console.error(`Erreur lecture (${key}):`, error.message);
                return null;
            }
            return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
        } catch (e) {
            console.error(`Erreur critique lecture (${key}):`, e);
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
            logger: pino({ level: 'silent' }), // Moins de bruit dans les logs
            printQRInTerminal: true,
            
            // 👇 SECTION CRITIQUE POUR RENDER & WHATSAPP 👇
            browser: ["Ubuntu", "Chrome", "20.0.04"], // ÉVITE L'ERREUR 401
            syncFullHistory: false,                   // ÉVITE LE CRASH MÉMOIRE
            generateHighQualityLinkPreview: false,    // ÉCONOMISE LE CPU
            connectTimeoutMs: 60000,                  // ÉVITE LES TIMEOUTS TROP COURTS
            // 👆 FIN SECTION CRITIQUE 👆
        });

        // --- GESTION DU CODE DE JUMELAGE (PAIRING CODE) ---
        if (phoneNumber && !sock.authState.creds.registered) {
            console.log("⏳ Attente 4s avant demande du code...");
            
            setTimeout(async () => {
                try {
                    // 1. Nettoyage strict du numéro (enlève + et espaces)
                    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`📞 Demande envoyée pour : ${cleanPhone}`);
                    
                    // 2. Demande du code à WhatsApp
                    const code = await sock.requestPairingCode(cleanPhone);
                    
                    // 3. Affichage dans les logs (Copie-le d'ici si besoin !)
                    console.log(`------------------------------------------------`);
                    console.log(`🔑 TON CODE DE CONNEXION EST : ${code}`);
                    console.log(`------------------------------------------------`);

                    // 4. Envoi dans Supabase pour le site
                    const { error } = await supabase
                        .from('instances')
                        .update({ qr_code: code, status: 'pairing_code' })
                        .eq('id', instanceId);
                    
                    if(error) console.error("❌ Erreur sauvegarde Supabase:", error.message);
                    else console.log("✅ Code sauvegardé dans Supabase");

                } catch (err) {
                    console.error("❌ ÉCHEC Pairing Code:", err.message || err);
                }
            }, 4000); // Délai vital pour laisser la connexion s'établir
        }

        // --- ÉVÉNEMENTS DE CONNEXION ---
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Gestion du QR Code (Seulement si on n'a PAS demandé de code tel)
            if (qr && !phoneNumber) {
                console.log("⚡ QR Code généré (Mode classique)");
                await supabase.from('instances').update({ qr_code: qr, status: 'scanning' }).eq('id', instanceId);
            }

            // Connexion RÉUSSIE
            if (connection === 'open') {
                console.log(`✅ SUCCÈS : ${instanceId} est connecté !`);
                await supabase.from('instances').update({ qr_code: null, status: 'connected' }).eq('id', instanceId);
            }

            // Connexion PERDUE ou FERMÉE
            if (connection === 'close') {
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`❌ Déconnexion (Code: ${statusCode}). Reconnexion auto : ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    // On relance
                    startWhatsApp(instanceId, phoneNumber);
                } else {
                    // C'est une déconnexion définitive (Logout)
                    console.log("⚠️ Session fermée définitivement.");
                    await supabase.from('instances').update({ status: 'disconnected' }).eq('id', instanceId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (e) {
        console.error("🚨 Erreur fatale dans startWhatsApp:", e);
    }
};

// --- ROUTES API ---
app.get('/', (req, res) => res.send('WhatsApp Worker is Running 🟢'));

app.post('/init-session', async (req, res) => {
    const { instanceId, phoneNumber } = req.body;
    
    if (!instanceId) {
        return res.status(400).json({ error: 'Instance ID manquant' });
    }

    // On lance le processus (sans attendre qu'il finisse pour ne pas bloquer le site)
    startWhatsApp(instanceId, phoneNumber).catch(e => console.error("Erreur init:", e));

    return res.json({ 
        status: 'initializing', 
        message: phoneNumber ? 'Génération du code...' : 'Génération du QR...' 
    });
});

// Démarrage du serveur
app.listen(PORT, () => console.log(`🚀 Serveur écoute sur le port ${PORT}`));
