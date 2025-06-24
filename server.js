require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const PORT = process.env.PORT || 3001;

// Validate required environment variables
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY is required');
  process.exit(1);
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error('❌ STRIPE_WEBHOOK_SECRET is required');
  process.exit(1);
}
if (!process.env.PTERODACTYL_API_KEY) {
  console.error('❌ PTERODACTYL_API_KEY is required');
  process.exit(1);
}
if (!process.env.PTERODACTYL_API_URL) {
  console.error('❌ PTERODACTYL_API_URL is required');
  process.exit(1);
}

const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const PTERODACTYL_BASE = process.env.PTERODACTYL_API_URL;

const app = express();

// Middleware
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Helper Functions
function generatePassword(length = 12) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

function generateUsername(email) {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const random = Math.floor(Math.random() * 1000);
  return `${base}${random}`;
}

// Pterodactyl Functions
async function createOrGetUser(email) {
  try {
    // Check if user exists
    const usersRes = await axios.get(`${PTERODACTYL_BASE}/users`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const existingUser = usersRes.data.data.find(u => u.attributes.email === email);
    if (existingUser) {
      return {
        userId: existingUser.attributes.id,
        username: existingUser.attributes.username,
        isNewUser: false
      };
    }

    // Create new user
    const username = generateUsername(email);
    const password = generatePassword();
    
    const userData = {
      email,
      username,
      first_name: 'Minecraft',
      last_name: 'Player',
      password
    };

    const createUserRes = await axios.post(`${PTERODACTYL_BASE}/users`, userData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      userId: createUserRes.data.attributes.id,
      username,
      password,
      isNewUser: true
    };
  } catch (err) {
    console.error('User creation failed:', err.response?.data || err.message);
    throw err;
  }
}

async function fetchPterodactylMeta(userId) {
  try {
    // Get Minecraft egg
    const eggsRes = await axios.get(`${PTERODACTYL_BASE}/nests/1/eggs`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const minecraftEgg = eggsRes.data.data.find(e => 
      e.attributes.name.toLowerCase().includes('minecraft')
    );
    if (!minecraftEgg) throw new Error('Minecraft egg not found');

    // Get first node and available allocation
    const nodesRes = await axios.get(`${PTERODACTYL_BASE}/nodes`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const nodeId = nodesRes.data.data[0].attributes.id;
    const allocRes = await axios.get(`${PTERODACTYL_BASE}/nodes/${nodeId}/allocations`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const allocation = allocRes.data.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No available allocations');

    return {
      userId,
      eggId: minecraftEgg.attributes.id,
      dockerImage: minecraftEgg.attributes.docker_image,
      startup: minecraftEgg.attributes.startup,
      allocationId: allocation.attributes.id,
      serverIp: allocation.attributes.ip,
      serverPort: allocation.attributes.port
    };
  } catch (err) {
    console.error('Pterodactyl meta fetch failed:', err.response?.data || err.message);
    throw err;
  }
}

async function createPterodactylServer(session) {
  try {
    const customerEmail = session.customer_details?.email || session.metadata?.customerEmail;
    if (!customerEmail) throw new Error('No customer email found');

    const userInfo = await createOrGetUser(customerEmail);
    const config = await fetchPterodactylMeta(userInfo.userId);

    // Extract server config from session metadata
    const metadata = session.metadata || {};
    const serverName = metadata.serverName || `MCServer-${Date.now()}`;
    const serverType = metadata.serverType || 'paper';
    const minecraftVersion = metadata.minecraftVersion || 'latest';
    const totalRam = parseInt(metadata.totalRam) || 4;

    // Create server
    const serverData = {
      name: serverName,
      user: config.userId,
      egg: config.eggId,
      docker_image: config.dockerImage,
      startup: config.startup,
      environment: {
        SERVER_JARFILE: 'server.jar',
        VERSION: minecraftVersion,
        SERVER_MEMORY: totalRam * 1024
      },
      limits: {
        memory: totalRam * 1024,
        disk: 5000,
        io: 500,
        cpu: 0
      },
      feature_limits: {
        databases: 1,
        allocations: 1,
        backups: 3
      },
      allocation: {
        default: config.allocationId
      }
    };

    const response = await axios.post(`${PTERODACTYL_BASE}/servers`, serverData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const server = response.data.attributes;
    return {
      serverId: server.id,
      serverName,
      serverIp: config.serverIp,
      serverPort: config.serverPort,
      username: userInfo.username,
      password: userInfo.isNewUser ? userInfo.password : undefined,
      panelUrl: PTERODACTYL_BASE.replace('/api/application', '')
    };
  } catch (err) {
    console.error('Server creation failed:', err.response?.data || err.message);
    throw err;
  }
}

// API Endpoints
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { serverConfig } = req.body;
    
    if (!serverConfig?.serverName) {
      return res.status(400).json({ error: 'Server name is required' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: `${serverConfig.serverType || 'Paper'} server`
          },
          unit_amount: 1000, // $10.00
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: {
        serverName: serverConfig.serverName,
        serverType: serverConfig.serverType || 'paper',
        minecraftVersion: serverConfig.minecraftVersion || 'latest',
        totalRam: String(serverConfig.totalRam || 4),
        customerEmail: serverConfig.customerEmail || ''
      }
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ 
        error: 'Invalid session ID',
        status: 'invalid_id'
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ 
        status: 'payment_pending',
        paymentStatus: session.payment_status
      });
    }

    if (session.metadata.serverCreated === 'true') {
      return res.json({
        status: 'ready',
        serverName: session.metadata.serverName,
        serverIp: session.metadata.serverIp,
        serverPort: session.metadata.serverPort
      });
    }

    // Create server since payment is complete but server doesn't exist
    const serverDetails = await createPterodactylServer(session);
    
    // Update session metadata
    await stripe.checkout.sessions.update(sessionId, {
      metadata: {
        ...session.metadata,
        serverCreated: 'true',
        serverIp: serverDetails.serverIp,
        serverPort: serverDetails.serverPort
      }
    });

    res.json({
      status: 'ready',
      ...serverDetails
    });

  } catch (err) {
    console.error('Server details error:', err);
    
    if (err.type === 'StripeInvalidRequestError') {
      return res.status(404).json({ 
        error: 'Session not found',
        status: 'not_found'
      });
    }
    
    res.status(500).json({ 
      error: err.message,
      status: 'error'
    });
  }
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Just log events - server creation happens via the /server-details endpoint
  console.log(`Stripe event: ${event.type}`);
  res.json({ received: true });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString() 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🦆 Goose Hosting API running on port ${PORT}`);
  console.log(`🔗 Pterodactyl: ${PTERODACTYL_BASE}`);
  console.log(`💳 Stripe mode: ${process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'TEST' : 'LIVE'}`);
});
