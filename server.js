const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'https://goosehosting.com', 'https://www.goosehosting.com'],
  credentials: true
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Safe parsing helper function
const safeParseInt = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') {
    console.log(`⚠️  safeParseInt: value is ${value}, using fallback ${fallback}`)
    return fallback
  }
  const parsed = parseInt(value)
  if (isNaN(parsed)) {
    console.log(`⚠️  safeParseInt: parsed value is NaN for input "${value}", using fallback ${fallback}`)
    return fallback
  }
  console.log(`✅ safeParseInt: successfully parsed "${value}" to ${parsed}`)
  return parsed
}

// Safe metadata creation helper
const createSafeMetadata = (serverConfig, planId, totalRam, maxPlayers, viewDistance, totalPrice) => {
  const selectedPluginsCount = Array.isArray(serverConfig.selectedPlugins) 
    ? serverConfig.selectedPlugins.length 
    : 0;

  const safeMetadata = {
    planId: String(planId || ''),
    serverName: String(serverConfig.serverName || ''),
    serverType: String(serverConfig.serverType || ''),
    minecraftVersion: String(serverConfig.minecraftVersion || ''),
    totalRam: String(Number.isFinite(totalRam) ? totalRam : 0),
    maxPlayers: String(Number.isFinite(maxPlayers) ? maxPlayers : 0),
    viewDistance: String(Number.isFinite(viewDistance) ? viewDistance : 0),
    enableWhitelist: String(Boolean(serverConfig.enableWhitelist)),
    enablePvp: String(Boolean(serverConfig.enablePvp)),
    selectedPlugins: String(selectedPluginsCount),
    customerEmail: String(serverConfig.customerEmail || ''),
    totalPrice: String(Number.isFinite(totalPrice) ? totalPrice.toFixed(2) : '0.00')
  };

  // Validate all metadata values
  console.log('🔎 Validating metadata values before sending to Stripe...');
  for (const [key, value] of Object.entries(safeMetadata)) {
    if (key === 'totalRam' || key === 'maxPlayers' || key === 'viewDistance' || key === 'selectedPlugins') {
      const parsed = parseInt(value);
      const isValid = !isNaN(parsed) && Number.isInteger(parsed);
      console.log(`- ${key}: "${value}" → ${isValid ? '✅ Valid (' + parsed + ')' : '❌ INVALID (NaN)'}`);
      
      if (!isValid) {
        console.error(`❌ CRITICAL: Invalid metadata value for ${key}: ${value}`);
        throw new Error(`Invalid metadata value for ${key}: ${value}`);
      }
    } else {
      console.log(`- ${key}: "${value}" → ✅ String value`);
    }
  }

  return safeMetadata;
};

// Main checkout session creation endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { serverConfig, planId } = req.body

    // 🚀 COMPREHENSIVE LOGGING STARTS HERE
    console.log('\n🚀 ===== BACKEND REQUEST RECEIVED =====')
    console.log('📅 Timestamp:', new Date().toISOString())
    console.log('🌐 Request URL:', req.url)
    console.log('📋 Request Method:', req.method)

    // Log the raw request body
    console.log('\n📥 RAW REQUEST BODY:')
    console.log('Type of req.body:', typeof req.body)
    console.log('Full req.body:', JSON.stringify(req.body, null, 2))

    // Log extracted values
    console.log('\n📦 EXTRACTED VALUES:')
    console.log('📥 Backend received serverConfig:', serverConfig)
    console.log('📥 Backend received planId:', planId)

    // Detailed serverConfig logging
    if (serverConfig) {
      console.log('\n🔍 DETAILED SERVER CONFIG ANALYSIS:')
      console.table({
        'Server Name': serverConfig?.serverName || 'MISSING',
        'Server Type': serverConfig?.serverType || 'MISSING',
        'Minecraft Version': serverConfig?.minecraftVersion || 'MISSING',
        'Total RAM': `${serverConfig?.totalRam} (${typeof serverConfig?.totalRam})`,
        'Max Players': `${serverConfig?.maxPlayers} (${typeof serverConfig?.maxPlayers})`,
        'View Distance': `${serverConfig?.viewDistance} (${typeof serverConfig?.viewDistance})`,
        'Enable Whitelist': `${serverConfig?.enableWhitelist} (${typeof serverConfig?.enableWhitelist})`,
        'Enable PvP': `${serverConfig?.enablePvp} (${typeof serverConfig?.enablePvp})`,
        'Customer Email': serverConfig?.customerEmail || 'MISSING',
        'Selected Plugins': Array.isArray(serverConfig?.selectedPlugins) ? `[${serverConfig.selectedPlugins.length} plugins]` : 'Invalid/Missing'
      })

      // Individual field validation logging
      console.log('\n🧪 INDIVIDUAL FIELD VALIDATION:')
      console.log('totalRam validation:')
      console.log('  - Raw value:', serverConfig.totalRam)
      console.log('  - Type:', typeof serverConfig.totalRam)
      console.log('  - Is number:', typeof serverConfig.totalRam === 'number')
      console.log('  - Is NaN:', isNaN(serverConfig.totalRam))
      console.log('  - Parsed int:', parseInt(serverConfig.totalRam))
      console.log('  - Is parsed NaN:', isNaN(parseInt(serverConfig.totalRam)))

      console.log('maxPlayers validation:')
      console.log('  - Raw value:', serverConfig.maxPlayers)
      console.log('  - Type:', typeof serverConfig.maxPlayers)
      console.log('  - Is number:', typeof serverConfig.maxPlayers === 'number')
      console.log('  - Is NaN:', isNaN(serverConfig.maxPlayers))

      console.log('viewDistance validation:')
      console.log('  - Raw value:', serverConfig.viewDistance)
      console.log('  - Type:', typeof serverConfig.viewDistance)
      console.log('  - Is number:', typeof serverConfig.viewDistance === 'number')
      console.log('  - Is NaN:', isNaN(serverConfig.viewDistance))

      console.log('selectedPlugins validation:')
      console.log('  - Raw value:', serverConfig.selectedPlugins)
      console.log('  - Type:', typeof serverConfig.selectedPlugins)
      console.log('  - Is array:', Array.isArray(serverConfig.selectedPlugins))
      console.log('  - Length:', Array.isArray(serverConfig.selectedPlugins) ? serverConfig.selectedPlugins.length : 'N/A')

    } else {
      console.log('❌ NO SERVER CONFIG RECEIVED!')
    }

    // Basic validation
    if (!serverConfig || !planId) {
      console.error('❌ Missing required fields:', { serverConfig: !!serverConfig, planId: !!planId })
      return res.status(400).json({ 
        error: 'Missing required fields: serverConfig and planId are required' 
      })
    }

    // Validate required serverConfig fields
    const requiredFields = ['serverName', 'serverType', 'minecraftVersion', 'customerEmail']
    const missingFields = requiredFields.filter(field => !serverConfig[field])
    
    if (missingFields.length > 0) {
      console.error('❌ Missing required serverConfig fields:', missingFields)
      return res.status(400).json({ 
        error: `Missing required fields: ${missingFields.join(', ')}` 
      })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(serverConfig.customerEmail)) {
      console.error('❌ Invalid email format:', serverConfig.customerEmail)
      return res.status(400).json({ 
        error: 'Invalid email format' 
      })
    }

    // Immediate validation with detailed logging
    console.log('\n🛡️  VALIDATION PHASE:')
    const totalRam = safeParseInt(serverConfig?.totalRam, 4)
    const maxPlayers = safeParseInt(serverConfig?.maxPlayers, 20)
    const viewDistance = safeParseInt(serverConfig?.viewDistance, 10)

    console.log('Validated values:')
    console.log('  - totalRam:', totalRam, '(original:', serverConfig?.totalRam, ')')
    console.log('  - maxPlayers:', maxPlayers, '(original:', serverConfig?.maxPlayers, ')')
    console.log('  - viewDistance:', viewDistance, '(original:', serverConfig?.viewDistance, ')')

    // Critical validation check
    if (!totalRam || isNaN(totalRam) || totalRam < 1) {
      console.error('❌ CRITICAL: Invalid totalRam value!')
      console.error('  - Original value:', serverConfig?.totalRam)
      console.error('  - Type:', typeof serverConfig?.totalRam)
      console.error('  - Parsed value:', totalRam)
      console.error('  - Is NaN:', isNaN(totalRam))
      return res.status(400).json({ 
        error: 'Invalid totalRam value: NaN or undefined',
        received: serverConfig?.totalRam,
        type: typeof serverConfig?.totalRam,
        parsed: totalRam
      })
    }

    // Validation summary
    console.log('\n✅ VALIDATION SUMMARY:')
    console.log('All numeric values valid:', {
      totalRam: !isNaN(totalRam) && totalRam > 0,
      maxPlayers: !isNaN(maxPlayers) && maxPlayers > 0,
      viewDistance: !isNaN(viewDistance) && viewDistance > 0
    })

    console.log('===== END BACKEND REQUEST LOG =====\n')
    // 🚀 COMPREHENSIVE LOGGING ENDS HERE

    // Define plan pricing
    const planPricing = {
      starter: { basePrice: 4.99, ram: 2 },
      pro: { basePrice: 9.99, ram: 4 },
      premium: { basePrice: 19.99, ram: 8 },
      enterprise: { basePrice: 39.99, ram: 16 }
    }

    // Get plan details
    const plan = planPricing[planId]
    if (!plan) {
      console.error('❌ Invalid plan ID:', planId)
      return res.status(400).json({ 
        error: 'Invalid plan ID' 
      })
    }

    // Calculate total price based on RAM
    const additionalRam = Math.max(0, totalRam - plan.ram)
    const additionalRamCost = additionalRam * 2.25 // $2.25 per GB
    let totalPrice = plan.basePrice + additionalRamCost

    // 🛡️ CRITICAL FIX: Ensure totalPrice is always a valid number
    if (!Number.isFinite(totalPrice) || isNaN(totalPrice) || totalPrice < 0) {
      console.error('❌ CRITICAL: Invalid totalPrice calculated!')
      console.error('  - Plan base price:', plan.basePrice)
      console.error('  - Additional RAM:', additionalRam)
      console.error('  - Additional RAM cost:', additionalRamCost)
      console.error('  - Calculated total:', totalPrice)
      
      // Fallback to base plan price
      totalPrice = plan.basePrice
      console.log('🔄 Using fallback price:', totalPrice)
    }

    console.log('\n💰 PRICING CALCULATION:')
    console.log('Plan:', planId, `($${plan.basePrice}/mo, ${plan.ram}GB base)`)
    console.log('Total RAM needed:', totalRam, 'GB')
    console.log('Additional RAM:', additionalRam, 'GB')
    console.log('Additional RAM cost:', `$${additionalRamCost.toFixed(2)}/mo`)
    console.log('Total monthly price:', `$${totalPrice.toFixed(2)}/mo`)

    // 🛡️ CRITICAL FIX: Validate unit_amount before sending to Stripe
    const unitAmountInCents = Math.round(totalPrice * 100)
    if (!Number.isInteger(unitAmountInCents) || unitAmountInCents < 50) { // Stripe minimum is $0.50
      console.error('❌ CRITICAL: Invalid unit_amount for Stripe!')
      console.error('  - Total price:', totalPrice)
      console.error('  - Unit amount (cents):', unitAmountInCents)
      return res.status(400).json({ 
        error: 'Invalid pricing calculation',
        totalPrice,
        unitAmountInCents
      })
    }

    console.log('\n🔄 Creating Stripe checkout session...')
    console.log('💰 Unit amount (cents):', unitAmountInCents)

    // 🧪 FINAL VALIDATION BEFORE STRIPE
    console.log('🔬 FINAL VALIDATION BEFORE STRIPE:')
    console.log('  totalPrice type:', typeof totalPrice)
    console.log('  totalPrice value:', totalPrice)
    console.log('  totalPrice * 100:', totalPrice * 100)
    console.log('  Math.round(totalPrice * 100):', Math.round(totalPrice * 100))
    console.log('  Is finite:', Number.isFinite(totalPrice))
    console.log('  Is NaN:', isNaN(totalPrice))
    
    // 🛡️ CREATE SAFE METADATA - This fixes the NaN issue!
    let safeMetadata;
    try {
      safeMetadata = createSafeMetadata(serverConfig, planId, totalRam, maxPlayers, viewDistance, totalPrice);
      console.log('✅ Safe metadata created successfully');
    } catch (metadataError) {
      console.error('❌ CRITICAL: Failed to create safe metadata:', metadataError.message);
      return res.status(400).json({ 
        error: 'Invalid data for metadata creation',
        details: metadataError.message
      });
    }
    
    // Create subscription metadata with safe serverConfig
    const safeServerConfigForSubscription = {
      serverName: String(serverConfig.serverName || ''),
      serverType: String(serverConfig.serverType || ''),
      minecraftVersion: String(serverConfig.minecraftVersion || ''),
      totalRam: totalRam,
      maxPlayers: maxPlayers,
      viewDistance: viewDistance,
      enableWhitelist: Boolean(serverConfig.enableWhitelist),
      enablePvp: Boolean(serverConfig.enablePvp),
      selectedPlugins: Array.isArray(serverConfig.selectedPlugins) 
        ? serverConfig.selectedPlugins 
        : [],
      customerEmail: String(serverConfig.customerEmail || '')
    };
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: serverConfig.customerEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Goose Hosting - ${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan`,
              description: `Minecraft Server: ${serverConfig.serverName} (${totalRam}GB RAM, ${maxPlayers} players)`,
              images: ['https://goosehosting.com/logo-stripe.png'],
            },
            unit_amount: unitAmountInCents, // ✅ Now guaranteed to be a valid integer
            recurring: {
              interval: 'month',
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/configure/${encodeURIComponent(serverConfig.serverName)}`,
      metadata: safeMetadata, // ✅ Using safe metadata that won't cause NaN errors
      subscription_data: {
        metadata: {
          planId: String(planId || ''),
          serverName: String(serverConfig.serverName || ''),
          totalRam: String(totalRam),
          serverConfig: JSON.stringify(safeServerConfigForSubscription)
        }
      }
    })

    console.log('✅ Stripe session created successfully!')
    console.log('Session ID:', session.id)
    console.log('Session URL:', session.url)

    // Send response
    res.json({
      sessionId: session.id,
      url: session.url,
      planId: planId,
      totalPrice: totalPrice.toFixed(2),
      serverConfig: {
        serverName: serverConfig.serverName,
        totalRam: totalRam,
        maxPlayers: maxPlayers,
        viewDistance: viewDistance
      }
    })

  } catch (error) {
    console.error('❌ Error creating checkout session:', error)
    console.error('Error stack:', error.stack)
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// Webhook endpoint for Stripe events
app.post('/webhook', express.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature']
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET

  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret)
    console.log('✅ Webhook signature verified')
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object
      console.log('🎉 Payment successful for session:', session.id)
      console.log('💰 Amount paid:', session.amount_total / 100, session.currency.toUpperCase())
      console.log('📧 Customer email:', session.customer_email)
      console.log('🖥️  Server metadata:', session.metadata)
      
      // Here you would typically:
      // 1. Provision the Minecraft server
      // 2. Send confirmation email
      // 3. Update your database
      // 4. Set up server monitoring
      
      break
    
    case 'invoice.payment_succeeded':
      const invoice = event.data.object
      console.log('💳 Monthly payment succeeded:', invoice.id)
      break
    
    case 'invoice.payment_failed':
      const failedInvoice = event.data.object
      console.log('❌ Monthly payment failed:', failedInvoice.id)
      break
    
    case 'customer.subscription.deleted':
      const subscription = event.data.object
      console.log('🗑️  Subscription cancelled:', subscription.id)
      break
    
    default:
      console.log(`🔔 Unhandled event type: ${event.type}`)
  }

  res.json({received: true})
})

// Success page data endpoint
app.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    
    console.log('🔍 Retrieving session:', sessionId)
    
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'customer']
    })

    console.log('✅ Session retrieved successfully')
    
    res.json({
      sessionId: session.id,
      customerEmail: session.customer_email,
      amountTotal: session.amount_total,
      currency: session.currency,
      paymentStatus: session.payment_status,
      metadata: session.metadata,
      subscriptionId: session.subscription?.id,
      customerId: session.customer?.id
    })
    
  } catch (error) {
    console.error('❌ Error retrieving session:', error)
    res.status(500).json({ 
      error: 'Failed to retrieve session data',
      message: error.message 
    })
  }
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err)
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  })
})

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  })
})

// Start server
app.listen(PORT, () => {
  console.log('\n🦆 ===== GOOSE HOSTING API SERVER =====')
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`🔑 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`)
  console.log(`🪝 Webhook configured: ${!!process.env.STRIPE_WEBHOOK_SECRET}`)
  console.log('======================================\n')
})
