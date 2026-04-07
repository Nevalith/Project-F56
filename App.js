import { Buffer } from 'buffer'
global.Buffer = Buffer
import React, { useState, useRef } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView
} from 'react-native'
import TcpSocket from 'react-native-tcp-socket'

// BMW F56 DoIP constants
const DOIP_PORT = 13400
const TESTER_ADDR = [0x0E, 0x80]
const DME_ADDR    = [0x00, 0x10]

// Discovery targets to try in order
const DISCOVERY_TARGETS = [
  '169.254.1.1',
  '169.254.255.255',
  '192.168.16.1'
]

export default function App() {
  const [status, setStatus]     = useState('Ready.\nPlug in ENET cable and tap Discover.')
  const [connState, setConnState] = useState('idle')
  const [log, setLog]           = useState([])

  const socketRef        = useRef(null)
  const discoveredIpRef  = useRef(null)
  const keepaliveRef     = useRef(null)

  // Add a line to the log
  const addLog = (line) => {
    const timestamp = new Date().toLocaleTimeString()
    setLog(prev => [`[${timestamp}] ${line}`, ...prev].slice(0, 50))
  }

  // Build a DoIP Vehicle Identification Request (UDP)
  const makeDiscoveryPayload = () => Buffer.from([
    0x02, 0xFD,             // Protocol version + inverse
    0x00, 0x01,             // Payload type: Vehicle Identification Request
    0x00, 0x00, 0x00, 0x00  // Payload length: 0
  ])

  // Build a DoIP Routing Activation Request (TCP)
  const makeRoutingActivation = () => Buffer.from([
    0x02, 0xFD,             // Version
    0x00, 0x05,             // Payload type: Routing Activation Request
    0x00, 0x00, 0x00, 0x07, // Length: 7
    0x0E, 0x80,             // Source address: 0x0E80 (tester)
    0x00,                   // Activation type: Default
    0x00, 0x00, 0x00, 0x00  // Reserved
  ])

  // Wrap UDS bytes in a DoIP Diagnostic Message frame (0x8001)
  const makeDoIPFrame = (udsBytes) => {
    const bodyLen = 2 + 2 + udsBytes.length // SA + DA + UDS
    return Buffer.from([
      0x02, 0xFD,                          // Version
      0x80, 0x01,                          // Payload type: Diagnostic Message
      0x00, 0x00,                          // Length high bytes
      (bodyLen >> 8) & 0xFF,               // Length byte 3
      bodyLen & 0xFF,                      // Length byte 4
      ...TESTER_ADDR,                      // SA: 0x0E80
      ...DME_ADDR,                         // DA: 0x0010 (DME)
      ...udsBytes                          // UDS payload
    ])
  }

  // ── DISCOVER ──────────────────────────────────────────────

  const discover = async () => {
    setConnState('discovering')
    setStatus('Searching for F56...')
    addLog('Starting DoIP discovery...')

    // Try each target IP in sequence
    for (const target of DISCOVERY_TARGETS) {
      addLog(`Trying ${target}...`)
      setStatus(`Trying ${target}...`)

      const found = await tryUDPDiscovery(target)
      if (found) {
        discoveredIpRef.current = target
        setConnState('discovered')
        setStatus(`F56 found at ${target}\nTap Connect to start session.`)
        addLog(`Vehicle found at ${target}`)
        return
      }
    }

    setConnState('error')
    setStatus('No response.\n\nCheck:\n• Ignition ON\n• ENET cable in OBD2 port\n• Phone connected via ENET adapter')
    addLog('Discovery failed — no response from any target')
  }

  const tryUDPDiscovery = (target) => {
    return new Promise((resolve) => {
      let resolved = false
      const finish = (result) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          resolve(result)
        }
      }

      // Timeout after 2 seconds per target
      const timer = setTimeout(() => finish(false), 2000)

      try {
        const payload = makeDiscoveryPayload()

        // react-native-tcp-socket UDP
        const udpClient = TcpSocket.createConnection(
          { host: target, port: DOIP_PORT, tls: false },
          () => {
            udpClient.write(payload)
          }
        )

        udpClient.on('data', () => {
          udpClient.destroy()
          finish(true)
        })

        udpClient.on('error', () => finish(false))
        udpClient.on('close', () => finish(false))

      } catch (e) {
        addLog(`UDP error: ${e.message}`)
        finish(false)
      }
    })
  }

  // ── CONNECT ───────────────────────────────────────────────

  const connect = () => {
    const ip = discoveredIpRef.current
    if (!ip) return

    setConnState('connecting')
    setStatus(`Opening session to ${ip}...`)
    addLog(`Connecting TCP to ${ip}:${DOIP_PORT}`)

    const socket = TcpSocket.createConnection(
      { host: ip, port: DOIP_PORT, tls: false },
      () => {
        addLog('TCP connected — sending Routing Activation...')
        socket.write(makeRoutingActivation())
      }
    )

    socket.on('data', (data) => {
      const hex = Buffer.from(data).toString('hex').toUpperCase()
      addLog(`RX: ${hex}`)

      const bytes = Buffer.from(data)

      // Routing Activation Response = payload type 0x0006
      if (bytes.length > 3 &&
          bytes[2] === 0x00 &&
          bytes[3] === 0x06) {
        addLog('Routing Activation successful')
        setConnState('connected')
        setStatus('Connected to F56.\nDiagnostic session active.')
        startKeepalive(socket)
      }
    })

    socket.on('error', (error) => {
      addLog(`Socket error: ${error.message}`)
      setConnState('error')
      setStatus(`Connection error:\n${error.message}`)
    })

    socket.on('close', () => {
      addLog('Socket closed')
      if (connState === 'connected') {
        setConnState('idle')
        setStatus('Connection closed.')
      }
    })

    socketRef.current = socket
  }

  // ── KEEPALIVE ─────────────────────────────────────────────

  const startKeepalive = (socket) => {
    if (keepaliveRef.current) clearInterval(keepaliveRef.current)

    keepaliveRef.current = setInterval(() => {
      try {
        // UDS 0x3E 0x80 = Tester Present, suppress response
        socket.write(makeDoIPFrame([0x3E, 0x80]))
        addLog('Tester Present sent')
      } catch (e) {
        clearInterval(keepaliveRef.current)
      }
    }, 4000)
  }

  // ── DISCONNECT ────────────────────────────────────────────

  const disconnect = () => {
    addLog('Disconnecting...')

    if (keepaliveRef.current) {
      clearInterval(keepaliveRef.current)
      keepaliveRef.current = null
    }

    try {
      // UDS 0x10 0x01 = Return to default session
      socketRef.current?.write(makeDoIPFrame([0x10, 0x01]))
      setTimeout(() => {
        socketRef.current?.destroy()
        socketRef.current = null
      }, 300)
    } catch (e) {
      socketRef.current?.destroy()
      socketRef.current = null
    }

    discoveredIpRef.current = null
    setConnState('idle')
    setStatus('Disconnected.\nSafe to unplug.')
  }

  // ── SEND A TEST UDS REQUEST ───────────────────────────────
  // UDS 0x22 0xF1 0x90 = Read VIN by DID
  const readVIN = () => {
    if (!socketRef.current) return
    addLog('Requesting VIN (0x22 0xF190)...')
    socketRef.current.write(makeDoIPFrame([0x22, 0xF1, 0x90]))
  }

  // ── UI ────────────────────────────────────────────────────

  const stateColor = {
    idle:        '#666',
    discovering: '#FFD60A',
    discovered:  '#0A84FF',
    connecting:  '#FF9F0A',
    connected:   '#30D158',
    error:       '#FF453A'
  }

  const stateLabel = {
    idle:        'IDLE',
    discovering: 'SEARCHING',
    discovered:  'FOUND',
    connecting:  'CONNECTING',
    connected:   'CONNECTED',
    error:       'ERROR'
  }

  return (
    <SafeAreaView style={styles.container}>

      {/* Status Card */}
      <View style={[styles.card, { borderColor: stateColor[connState] + '66' }]}>
        <View style={[styles.dot, { backgroundColor: stateColor[connState] }]} />
        <Text style={[styles.stateLabel, { color: stateColor[connState] }]}>
          {stateLabel[connState]}
        </Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {/* Buttons */}
      <View style={styles.buttons}>
        <ActionButton
          label="Discover F56"
          color="#0A84FF"
          disabled={connState === 'connecting' || connState === 'connected'}
          onPress={discover}
        />
        <ActionButton
          label="Connect"
          color="#30D158"
          disabled={connState !== 'discovered'}
          onPress={connect}
        />
        <ActionButton
          label="Read VIN"
          color="#FF9F0A"
          disabled={connState !== 'connected'}
          onPress={readVIN}
        />
        <ActionButton
          label="Disconnect"
          color="#FF453A"
          disabled={connState !== 'connected'}
          onPress={disconnect}
        />
      </View>

      {/* Log */}
      <View style={styles.logContainer}>
        <Text style={styles.logHeader}>DIAGNOSTIC LOG</Text>
        <ScrollView style={styles.logScroll}>
          {log.map((line, i) => (
            <Text key={i} style={styles.logLine}>{line}</Text>
          ))}
        </ScrollView>
      </View>

    </SafeAreaView>
  )
}

function ActionButton({ label, color, disabled, onPress }) {
  return (
    <TouchableOpacity
      style={[
        styles.button,
        { borderColor: disabled ? color + '33' : color + '99' }
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={[
        styles.buttonText,
        { color: disabled ? color + '44' : color }
      ]}>
        {label}
      </Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    padding: 16
  },
  card: {
    backgroundColor: '#111',
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginBottom: 8
  },
  stateLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.5,
    marginBottom: 8
  },
  statusText: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
    fontFamily: 'Courier',
    lineHeight: 22
  },
  buttons: {
    gap: 10,
    marginBottom: 16
  },
  button: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    backgroundColor: '#111'
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600'
  },
  logContainer: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#222',
    padding: 12
  },
  logHeader: {
    color: '#444',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 2,
    marginBottom: 8
  },
  logScroll: {
    flex: 1
  },
  logLine: {
    color: '#0f0',
    fontSize: 11,
    fontFamily: 'Courier',
    lineHeight: 18
  }
})
