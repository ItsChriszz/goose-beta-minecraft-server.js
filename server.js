require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Deployment tracking (in-memory for demo, use DB in production)
const deployments = new Map();

// Enhanced logging
const log = (event, data = {}) => {
  console.log(`[${new Date().toISOString()}] ${event}`, JSON.stringify(data, null, 2));
};

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(bodyParser.json());

// 1. Pterodactyl Server Creation
const createPterodactylServer = async (session) => {
  try {
    const { metadata } = session;
    log('Starting Pterodactyl server creation', { metadata });

    // Fetch available resources from Pterodactyl
    const [user, egg, allocation] = await Promise.all([
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/users?filter=email=${metadata.customerEmail}`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      }),
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/nests/1/eggs?filter=name=Minecraft%20Java`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      }),
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/nodes/1/allocations`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      })
    ]);

    // Find first free allocation
    const freeAllocation = allocation.data.data.find(a => !a.attributes.assigned);
    if (!freeAllocation) throw new Error('No free allocations available');

    // Server configuration
    const serverConfig = {
      name: metadata.serverName,
      user: user.data.data[0].attributes.id,
      egg: egg.data.data[0].attributes.id,
      docker_image: egg.data.data[0].attributes.docker_image,
      startup: `java -Xms128M -Xmx${metadata.totalRam * 1024}M -jar server.jar nogui`,
      environment: {
        SERVER_JARFILE: 'server.jar',
        BUILD_NUMBER: 'latest',
        EULA: 'TRUE'
      },
      limits: {
        memory: metadata.totalRam * 1024,
        disk: 1024 * 5, // 5GB
        io: 500,
        cpu: 100
      },
      feature_limits: {
        databases: 1,
        backups: 3
      },
      allocation: {
        default: freeAllocation.attributes.id
      }
    };

    // Create server
    const { data: server } = await axios.post(
      `${process.env.PTERODACTYL_URL}/api/application/servers`,
      serverConfig,
      { headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` } }
    );

    const deployment = {
      status: 'active',
      serverId: server.attributes.id,
      identifier: server.attributes.identifier,
      allocation: freeAllocation.attributes.id,
      ip: freeAllocation.attributes.ip,
      port: freeAllocation.attributes.port,
      createdAt: new Date().toISOString()
    };

    deployments.set(session.id, deployment);
    log('Server created successfully', deployment);
    return deployment;

  } catch (error) {
    log('Pterodactyl creation failed', { error: error.message });
    throw error;
  }
};

// 2. Stripe Webhook Handler
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    log('Stripe webhook received', { type: event.type });

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const deployment = await createPterodactylServer(session);
      
      // Update Stripe metadata with server details
      await stripe.checkout.sessions.update(session.id, {
        metadata: {
          ...session.metadata,
          serverId: deployment.serverId,
          serverIp: `${deployment.ip}:${deployment.port}`
        }
      });
    }

    res.json({ received: true });
  } catch (err) {
    log('Webhook processing error', { error: err.message });
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// 3. Checkout Endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, serverConfig, customerEmail } = req.body;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      ui_mode: 'hosted'
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Minecraft Server - ${serverConfig.name}` },
          unit_amount: plan.price * 100,
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: {
        ...serverConfig,
        customerEmail,
        planId: plan.id
      }
    });

    log('Checkout session created', { sessionId: session.id });
    res.json({ sessionId: session.id, checkoutUrl: session.url });

  } catch (err) {
    log('Checkout creation failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// 4. Deployment Status Endpoint
app.get('/deployment/:sessionId', async (req, res) => {
  try {
    const deployment = deployments.get(req.params.sessionId);
    if (!deployment) throw new Error('Deployment not found');

    // Verify with Pterodactyl
    const { data } = await axios.get(
      `${process.env.PTERODACTYL_URL}/api/application/servers/${deployment.serverId}`,
      { headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` } }
    );

    res.json({
      status: data.attributes.status,
      ip: deployment.ip,
      port: deployment.port,
      name: data.attributes.name
    });
  } catch (err) {
    log('Deployment status error', { error: err.message });
    res.status(404).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  log(`Server started on port ${PORT}`, {
    stripe: process.env.STRIPE_SECRET_KEY ? 'Ready' : 'Not Configured',
    pterodactyl: process.env.PTERODACTYL_KEY ? 'Ready' : 'Not Configured'
  });
});
