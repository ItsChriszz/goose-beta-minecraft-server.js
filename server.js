// ServerConfiguration.jsx - FIXED VERSION with Better RAM Validation
import React, { useState, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { Crown } from "lucide-react"
import Header from "./Header"
import PlanSelector from "./PlanSelector"
import ConfigurationTabs from "./ConfigurationTabs"
import DeploySection from "./DeploySection"
import { plans, minecraftVersions, serverTypes, popularPlugins } from "./ServerData"

export default function ServerConfiguration() {
  const { serverName: urlServerName } = useParams()
  const navigate = useNavigate()
  
  const [activeTab, setActiveTab] = useState("basic")
  const [serverName, setServerName] = useState(() => {
    try {
      return decodeURIComponent(urlServerName || "")
    } catch {
      return ""
    }
  })
  const [maxPlayers, setMaxPlayers] = useState(20)
  const [ramAllocation, setRamAllocation] = useState(4)
  const [viewDistance, setViewDistance] = useState(10)
  const [enableWhitelist, setEnableWhitelist] = useState(false)
  const [enablePvp, setEnablePvp] = useState(true)
  const [selectedPlugins, setSelectedPlugins] = useState([])
  const [selectedServerType, setSelectedServerType] = useState("")
  const [selectedPlan, setSelectedPlan] = useState("pro")
  const [minecraftVersion, setMinecraftVersion] = useState("")
  const [isDeploying, setIsDeploying] = useState(false)
  const [additionalRam, setAdditionalRam] = useState(0) // Initialize as number
  const [isMobile, setIsMobile] = useState(false)
  const [customerEmail, setCustomerEmail] = useState("")

  // Helper function to safely parse numbers
  const safeParseInt = (value, fallback = 0) => {
    if (value === null || value === undefined || value === '') return fallback
    const parsed = parseInt(value)
    return isNaN(parsed) ? fallback : parsed
  }

  const safeParseFloat = (value, fallback = 0) => {
    if (value === null || value === undefined || value === '') return fallback
    const parsed = parseFloat(value)
    return isNaN(parsed) ? fallback : parsed
  }

  // Safe plan getter with fallback
  const getCurrentPlan = () => {
    const plan = plans.find(p => p && p.id === selectedPlan)
    if (!plan) {
      console.warn(`Plan not found: ${selectedPlan}, using default pro plan`)
      return plans.find(p => p.id === 'pro') || plans[1] || {
        id: 'pro',
        name: 'Honker Pro', 
        ram: 4,
        price: 9.99,
        maxPlayers: 30,
        features: ['Default plan']
      }
    }
    return plan
  }

  const currentPlan = getCurrentPlan()

  // FIXED: Much more robust RAM calculation
  const getTotalRam = () => {
    try {
      // Get plan base RAM with multiple fallbacks
      let planBaseRam = currentPlan.ram
      if (typeof planBaseRam === 'string') {
        planBaseRam = safeParseInt(planBaseRam, 4)
      } else if (typeof planBaseRam !== 'number' || isNaN(planBaseRam)) {
        planBaseRam = 4
      }

      // Get additional RAM with validation
      const additionalRamValue = safeParseInt(additionalRam, 0)

      const total = planBaseRam + additionalRamValue

      // Final validation - ensure we return a valid positive number
      if (isNaN(total) || total < 1) {
        console.warn('Invalid total RAM calculated, using fallback of 4GB')
        return 4
      }

      console.log('RAM Calculation:', {
        planBaseRam,
        additionalRam: additionalRamValue,
        total,
        currentPlan: currentPlan.id
      })

      return total
    } catch (error) {
      console.error('Error calculating total RAM:', error)
      return 4
    }
  }

  const totalRam = getTotalRam()

  // Safe cost calculation
  const getTotalMonthlyCost = () => {
    try {
      const basePrice = safeParseFloat(currentPlan.price, 9.99)
      const additionalRamCost = safeParseInt(additionalRam, 0) * 2.25
      return basePrice + additionalRamCost
    } catch (error) {
      console.error('Error calculating total cost:', error)
      return 9.99
    }
  }

  const totalMonthlyCost = getTotalMonthlyCost()

  // Check screen size and scroll to top when component mounts
  useEffect(() => {
    const checkScreenSize = () => {
      setIsMobile(window.innerWidth < 768)
    }

    checkScreenSize()
    window.addEventListener('resize', checkScreenSize)
    
    window.scrollTo({
      top: 0,
      left: 0,
      behavior: 'smooth'
    })

    return () => window.removeEventListener('resize', checkScreenSize)
  }, [])

  const handleBackToDashboard = () => {
    navigate('/')
  }

  // Filter server types based on plan and RAM with safety checks
  const getAvailableServerTypes = () => {
    try {
      if (!Array.isArray(serverTypes)) return []
      
      if (selectedPlan === "starter") {
        return serverTypes.filter(type => type && type.id === "paper")
      }
      if (totalRam < 4) {
        return serverTypes.filter(type => type && (type.minRam || 0) <= totalRam)
      }
      if (totalRam < 6) {
        return serverTypes.filter(type => type && type.id !== "forge")
      }
      return serverTypes
    } catch (error) {
      console.error('Error getting available server types:', error)
      return []
    }
  }

  // Filter plugins based on plan
  const getAvailablePlugins = () => {
    try {
      if (selectedPlan === "starter") {
        return []
      }
      return Array.isArray(popularPlugins) ? popularPlugins : []
    } catch (error) {
      console.error('Error getting available plugins:', error)
      return []
    }
  }

  // FIXED: Enhanced deploy function with comprehensive validation
  const handleDeployServer = async () => {
    console.log('🚀 Starting deployment validation...')
    
    // Pre-deployment validation with detailed logging
    const validationErrors = []
    
    if (!serverName?.trim()) {
      validationErrors.push('Server name is required')
    }
    if (!minecraftVersion) {
      validationErrors.push('Minecraft version is required')
    }
    if (!selectedServerType) {
      validationErrors.push('Server type is required')
    }
    if (!customerEmail?.trim() || !customerEmail.includes('@')) {
      validationErrors.push('Valid email address is required')
    }

    // CRITICAL: Validate RAM values before sending
    const finalTotalRam = getTotalRam()
    if (isNaN(finalTotalRam) || finalTotalRam < 1) {
      validationErrors.push(`Invalid RAM configuration: ${finalTotalRam}`)
    }

    if (validationErrors.length > 0) {
      alert('Please fix the following issues:\n' + validationErrors.join('\n'))
      return
    }

    // Check environment variables
    const stripePublicKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY
    if (!stripePublicKey) {
      console.error('❌ VITE_STRIPE_PUBLIC_KEY is missing')
      alert('Configuration error: Stripe key is missing. Please contact support.')
      return
    }

    setIsDeploying(true)
    
    try {
      // Create server configuration with BULLETPROOF validation
      const validatedMaxPlayers = Math.max(1, safeParseInt(maxPlayers, 20))
      const validatedViewDistance = Math.max(3, safeParseInt(viewDistance, 10))
      
      const serverConfig = {
        serverName: String(serverName?.trim() || ''),
        serverType: String(selectedServerType),
        minecraftVersion: String(minecraftVersion),
        maxPlayers: validatedMaxPlayers,
        totalRam: finalTotalRam,
        viewDistance: validatedViewDistance,
        enableWhitelist: Boolean(enableWhitelist),
        enablePvp: Boolean(enablePvp),
        selectedPlugins: Array.isArray(selectedPlugins) ? selectedPlugins : [],
        customerEmail: String(customerEmail?.trim() || '')
      }

      // BULLETPROOF validation before sending
      console.log('🔍 Final validation check:')
      console.log('Raw additionalRam:', additionalRam, typeof additionalRam)
      console.log('Raw maxPlayers:', maxPlayers, typeof maxPlayers)
      console.log('Raw viewDistance:', viewDistance, typeof viewDistance)
      console.log('Plan base RAM:', currentPlan.ram, typeof currentPlan.ram)
      console.log('Calculated totalRam:', finalTotalRam, typeof finalTotalRam)
      console.log('Validated maxPlayers:', validatedMaxPlayers, typeof validatedMaxPlayers)
      console.log('Validated viewDistance:', validatedViewDistance, typeof validatedViewDistance)
      console.log('All values valid?', {
        totalRam: !isNaN(finalTotalRam) && finalTotalRam > 0,
        maxPlayers: !isNaN(validatedMaxPlayers) && validatedMaxPlayers > 0,
        viewDistance: !isNaN(validatedViewDistance) && validatedViewDistance > 0
      })

      // Triple check all numeric values
      if (isNaN(serverConfig.totalRam)) {
        throw new Error(`CRITICAL: totalRam is NaN! Raw values - additionalRam: ${additionalRam}, planRam: ${currentPlan.ram}`)
      }
      if (isNaN(serverConfig.maxPlayers)) {
        throw new Error(`CRITICAL: maxPlayers is NaN! Raw value: ${maxPlayers}`)
      }
      if (isNaN(serverConfig.viewDistance)) {
        throw new Error(`CRITICAL: viewDistance is NaN! Raw value: ${viewDistance}`)
      }

      console.log('🦆 GOOSE HOSTING - Creating Checkout Session')
      console.log('==========================================')
      console.log('📋 Server Configuration:', serverConfig)
      console.log('💰 Plan:', selectedPlan, `($${currentPlan.price}/mo)`)
      console.log('💵 Total Cost:', `$${totalMonthlyCost.toFixed(2)}/mo`)
      console.log('🧠 Total RAM:', finalTotalRam + 'GB')
      console.log('==========================================')

      // Call backend API
      const apiUrl = import.meta.env.VITE_API_URL || 'https://stripeapibeta.goosehosting.com'
      console.log('🌐 API URL:', apiUrl)
      
      const response = await fetch(`${apiUrl}/create-checkout-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          planId: selectedPlan,
          serverConfig: serverConfig
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error('❌ Backend response error:', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
          sentConfig: serverConfig
        })
        throw new Error(`Backend error (${response.status}): ${errorText}`)
      }

      const responseData = await response.json()
      const { sessionId, url } = responseData
      
      if (!sessionId) {
        console.error('❌ No session ID in response:', responseData)
        throw new Error('Invalid response from server: missing session ID')
      }

      console.log('✅ Checkout session created:', sessionId)

      // Check if Stripe.js is loaded
      if (!window.Stripe) {
        throw new Error('Stripe.js not loaded. Please refresh the page and try again.')
      }

      // Initialize Stripe
      console.log('🔄 Initializing Stripe...')
      const stripe = window.Stripe(stripePublicKey)
      
      if (!stripe) {
        throw new Error('Failed to initialize Stripe. Please check configuration.')
      }

      console.log('🔄 Redirecting to Stripe Checkout...')

      // Redirect to Stripe Checkout
      if (url) {
        // Use direct URL if provided
        window.location.href = url
      } else {
        // Use session ID
        const { error } = await stripe.redirectToCheckout({
          sessionId: sessionId,
        })

        if (error) {
          console.error('❌ Stripe redirect error:', error)
          throw new Error(`Payment redirect failed: ${error.message}`)
        }
      }

    } catch (error) {
      console.error('❌ Deployment error:', error)
      
      // More specific error messages
      let errorMessage = 'Failed to start deployment'
      if (error.message.includes('fetch')) {
        errorMessage = 'Network error: Could not connect to payment server'
      } else if (error.message.includes('Stripe')) {
        errorMessage = 'Payment system error: ' + error.message
      } else if (error.message.includes('CRITICAL')) {
        errorMessage = 'Configuration error: ' + error.message
      } else {
        errorMessage = error.message
      }
      
      alert(`${errorMessage}\n\nPlease try again or contact support if the issue persists.`)
      setIsDeploying(false)
    }
  }

  const togglePlugin = (pluginId) => {
    setSelectedPlugins((prev) => 
      prev.includes(pluginId) 
        ? prev.filter((id) => id !== pluginId) 
        : [...prev, pluginId]
    )
  }

  // Reset server type if it becomes unavailable
  useEffect(() => {
    const availableTypes = getAvailableServerTypes()
    if (selectedServerType && !availableTypes.find(type => type.id === selectedServerType)) {
      setSelectedServerType("")
    }
  }, [selectedPlan, totalRam])

  // Reset plugins if plan doesn't support them
  useEffect(() => {
    if (selectedPlan === "starter" && selectedPlugins.length > 0) {
      setSelectedPlugins([])
    }
  }, [selectedPlan])

  // FIXED: Safer RAM allocation setter
  const handleRamAllocationChange = (value) => {
    try {
      console.log('🔧 RAM allocation change requested:', value, typeof value)
      
      // Validate input
      const newValue = safeParseInt(value, 4)
      if (newValue < 1) {
        console.warn('Invalid RAM value, using minimum of 1GB')
        return
      }
      
      // Get plan base RAM safely
      let planBaseRam = currentPlan.ram
      if (typeof planBaseRam === 'string') {
        planBaseRam = safeParseInt(planBaseRam, 4)
      } else if (typeof planBaseRam !== 'number' || isNaN(planBaseRam)) {
        planBaseRam = 4
      }

      // Calculate additional RAM needed
      const additional = Math.max(0, newValue - planBaseRam)
      
      console.log('💾 RAM calculation:', {
        requestedValue: newValue,
        planBaseRam,
        additionalNeeded: additional
      })
      
      setAdditionalRam(additional)
    } catch (error) {
      console.error('Error setting RAM allocation:', error)
    }
  }

  const configProps = {
    serverName,
    setServerName,
    minecraftVersion,
    setMinecraftVersion,
    selectedServerType,
    setSelectedServerType,
    maxPlayers,
    setMaxPlayers,
    ramAllocation: totalRam,
    setRamAllocation: handleRamAllocationChange,
    viewDistance,
    setViewDistance,
    enableWhitelist,
    setEnableWhitelist,
    enablePvp,
    setEnablePvp,
    selectedPlugins,
    togglePlugin,
    currentPlan,
    availableServerTypes: getAvailableServerTypes(),
    availablePlugins: getAvailablePlugins(),
    additionalRam: safeParseInt(additionalRam, 0), // Ensure it's always a number
    setAdditionalRam: (value) => setAdditionalRam(safeParseInt(value, 0)),
    totalMonthlyCost,
    customerEmail,
    setCustomerEmail
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900/30 to-slate-900">
      {/* Animated Background */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-20 left-10 w-32 h-32 bg-blue-500/10 rounded-full blur-xl animate-pulse"></div>
        <div className="absolute bottom-32 right-20 w-40 h-40 bg-purple-500/10 rounded-full blur-xl animate-pulse" style={{animationDelay: '1s'}}></div>
        <div className="absolute top-1/3 right-1/4 w-24 h-24 bg-green-500/10 rounded-full blur-xl animate-pulse" style={{animationDelay: '2s'}}></div>
      </div>

      {/* Header */}
      <Header onBackToDashboard={handleBackToDashboard} />

      {/* Content */}
      <div className={`container mx-auto px-4 py-8 relative z-10 ${
        isMobile ? 'pt-20' : 'pt-8'
      }`}>
        <div className="max-w-7xl mx-auto">
          {/* Mobile Back Button */}
          {isMobile && (
            <div className="mb-6">
              <button 
                onClick={handleBackToDashboard}
                className="flex items-center gap-3 px-4 py-3 text-white hover:bg-white/10 rounded-xl transition-all duration-200 hover:scale-105 border border-white/20 backdrop-blur-sm"
              >
                <span className="text-xl">🦆</span>
                <span className="font-medium">Back to Home</span>
              </button>
            </div>
          )}

          {/* Page Header */}
          <div className="text-center mb-8 md:mb-12">
            <div className="inline-flex items-center gap-2 bg-slate-800/50 backdrop-blur-sm rounded-full px-4 md:px-6 py-2 md:py-3 mb-4 md:mb-6 border border-slate-700/50">
              <Crown size={16} className="text-yellow-400 md:w-5 md:h-5" />
              <span className="text-gray-300 text-xs md:text-sm font-medium">Server Configuration</span>
            </div>
            
            <h1 className="text-3xl md:text-5xl lg:text-6xl font-black text-white mb-4 md:mb-6 leading-tight px-2">
              Configure Your
              <span className="block bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent"> Dream Server</span>
            </h1>
            
            <p className="text-base md:text-xl text-gray-300 max-w-2xl mx-auto mb-4 px-4">
              Customize every aspect of your Minecraft server with our AI-powered configuration system
            </p>
            
            {serverName && (
              <div className="inline-flex items-center gap-2 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 backdrop-blur-sm rounded-full px-4 md:px-6 py-2 md:py-3 border border-cyan-500/30 mx-4">
                <span className="text-cyan-400 font-semibold text-sm md:text-lg">"{serverName}"</span>
              </div>
            )}
          </div>

          {/* Email Collection */}
          <div className="max-w-md mx-auto mb-8">
            <div className="bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 rounded-xl p-6">
              <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                📧 Contact Information
              </h3>
              <p className="text-gray-300 text-sm mb-4">
                We'll use this email to send you server details and important updates.
              </p>
              <input
                type="email"
                placeholder="your.email@example.com"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                className="w-full px-4 py-3 bg-slate-900/50 border border-slate-600/50 rounded-xl text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200"
                required
              />
              {!customerEmail.trim() && (
                <p className="text-red-400 text-xs mt-2">Email address is required</p>
              )}
            </div>
          </div>

          {/* Debug Panel (remove in production) */}
          {process.env.NODE_ENV === 'development' && (
            <div className="max-w-md mx-auto mb-8 p-4 bg-yellow-900/20 border border-yellow-500/30 rounded-xl">
              <h4 className="text-yellow-400 font-bold mb-2">🐛 Debug Info</h4>
              <div className="text-xs text-yellow-200 space-y-1">
                <div>Plan RAM: {currentPlan.ram} ({typeof currentPlan.ram})</div>
                <div>Additional RAM: {additionalRam} ({typeof additionalRam})</div>
                <div>Total RAM: {totalRam} ({typeof totalRam})</div>
                <div>Is Total RAM valid: {!isNaN(totalRam) && totalRam > 0 ? '✅' : '❌'}</div>
              </div>
            </div>
          )}

          {/* Layout */}
          <div className="space-y-6 lg:space-y-0 lg:grid lg:grid-cols-4 lg:gap-8">
            {/* Sidebar with Plan Selection */}
            <div className="lg:col-span-1 order-2 lg:order-1">
              <PlanSelector 
                selectedPlan={selectedPlan}
                setSelectedPlan={setSelectedPlan}
                currentPlan={currentPlan}
                maxPlayers={maxPlayers}
                selectedPlugins={selectedPlugins}
                totalMonthlyCost={totalMonthlyCost}
                totalRam={totalRam}
                additionalRam={safeParseInt(additionalRam, 0)}
                setAdditionalRam={(value) => setAdditionalRam(safeParseInt(value, 0))}
              />
            </div>

            {/* Main Configuration Area */}
            <div className="lg:col-span-3 order-1 lg:order-2">
              <ConfigurationTabs 
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                {...configProps}
              />
            </div>
          </div>

          <DeploySection 
            currentPlan={currentPlan}
            onDeploy={handleDeployServer}
            isDeploying={isDeploying}
            serverName={serverName}
            selectedServerType={selectedServerType}
            minecraftVersion={minecraftVersion}
            totalMonthlyCost={totalMonthlyCost}
            totalRam={totalRam}
            customerEmail={customerEmail}
          />
        </div>
      </div>
    </div>
  )
}
