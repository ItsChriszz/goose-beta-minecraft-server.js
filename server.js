require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(bodyParser.json());

// ✅ 1. Improved Pterodactyl Server Creation
const createPterodactylServer = async (session) => {
  try {
    // Get email from Stripe session (✅ Now from customer_details)
    const customerEmail = session.customer_details?.email;
    if (!customerEmail) throw new Error("No email associated with payment");

    // Fetch Pterodactyl resources
    const [user, egg, allocation] = await Promise.all([
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/users?filter=email=${encodeURIComponent(customerEmail)}`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      }),
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/nests/1/eggs?filter=name=Minecraft%20Java`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      }),
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/nodes/1/allocations`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      })
    ]);

    // Find free allocation
    const freeAlloc = allocation.data.data.find(a => !a.attributes.assigned);
    if (!freeAlloc) throw new Error("No server capacity available");

    // Create server
    const { data } = await axios.post(
      `${process.env.PTERODACTYL_URL}/api/application/servers`,
      {
        name: session.metadata.serverName,
        user: user.data.data[0].attributes.id,
        egg: egg.data.data[0].attributes.id,
        docker_image: egg.data.data[0].attributes.docker_image,
        startup: "java -Xms128M -Xmx${session.metadata.totalRam * 1024}M -jar server.jar nogui",
        environment: {
          EULA: "TRUE",
          SERVER_JARFILE: "server.jar",
          VERSION: session.metadata.minecraftVersion
        },
        limits: {
          memory: session.metadata.totalRam * 1024,
          disk: 1024 * 5,
          cpu: 100
        },
        allocation: {
          default: freeAlloc.attributes.id
        }
      },
      { headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` } }
    );

    return {
      serverId: data.attributes.id,
      identifier: data.attributes.identifier,
      ip: freeAlloc.attributes.ip,
      port: freeAlloc.attributes.port
    };

  } catch (error) {
    console.error("Deployment failed:", error.message);
    // ✅ Record error in Stripe metadata
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        ...session.metadata,
        deploymentError: error.message,
        failedAt: new Date().toISOString()
      }
    });
    throw error;
  }
};

// ✅ 2. Webhook handler using Stripe email
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log(`Processing payment for ${session.customer_details?.email}`);
      
      const server = await createPterodactylServer(session);
      console.log(`Server created: ${server.ip}:${server.port}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ✅ 3. Simplified checkout endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, serverConfig } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      ui_mode: 'hosted',
      customer_email: serverConfig.customerEmail, // Optional: pre-fill email
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { 
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: `${serverConfig.serverType} ${serverConfig.minecraftVersion}`
          },
          unit_amount: Math.round(serverConfig.totalCost * 100),
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: serverConfig // No need for separate email anymore
    });

    res.json({ 
      sessionId: session.id,
      checkoutUrl: session.url 
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 4. Enhanced status endpoint
app.get('/deployment-status/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId, {
      expand: ['customer']
    });

    if (session.metadata.deploymentError) {
      return res.status(500).json({ 
        status: 'failed',
        error: session.metadata.deploymentError,
        customerEmail: session.customer_details?.email
      });
    }

    res.json({
      status: 'completed',
      customerEmail: session.customer_details?.email,
      ...session.metadata
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Stripe webhook URL: ${process.env.FRONTEND_URL}/webhook`);
});
