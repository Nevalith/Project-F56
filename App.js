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

const DOIP_PORT = 13400
const TESTER_ADDR = [0x0E, 0x80]
const DME_ADDR    = [0x00, 0x10]

const DISCOVERY_TARGETS = [
  '169.254.1.1',
  '169.254.0.1',
  '169.254.100.1',
  '169.254.124.1',
  '169.254.255.255'
]

const TCP_TARGETS = [
  '169.254.1.1',
  '169.254.0.1',
  '169.254.124.1',
  '169.254.100.1'
]

export default function App() {
  const [status, setStatus]       = useState('Ready.\nPlug in ENET cable and tap Discover.')
  const [connState, setConnState] = useState('idle')
  const [log, setLog]             = useState([])

  const socketRef       = useRef(null)
  const discoveredIpRef = useRef(null)
  const keepaliveRef    = useRef(null)

  const addLog = (line) => {
    const timestamp = new Date().toLocaleTimeString()
    setLog(prev => [`[${timestamp}] ${line}`, ...prev].slice(0, 50))
  }

  const makeDiscoveryPayload = () => Buffer.from([
    0x02, 0xFD,
    0x00, 0x01,
    0x00, 0x00, 0x00, 0x00
  ])

  const makeRoutingActivation = () => Buffer.from([
    0x02, 0xFD,
    0x00, 0x05,
    0x00, 0x00, 0x00, 0x07,
    0x0E, 0x80,
    0x00,
    0x00, 0x00, 0x00, 0x00
  ])

  const makeDoIPFrame = (udsBytes) => {
    const bodyLen = 2 + 2 + udsBytes.length
    return Buffer.from([
      0x02, 0xFD,
      0x80, 0x01,
      0x00, 0x00,
      (bodyLen >> 8) & 0xFF,
      bodyLen & 0xFF,
      ...TESTER_ADDR,
      ...DME_ADDR,
      ...udsBytes
    ])
  }

  // ── DISCOVER ──────────────────────────────────────────────

  const discover = async () => {
    setConnState('discovering')
    setStatus('Searching for F56...')
    addLog('Starting DoIP discovery...')

    const payload = makeDiscoveryPayload()

    // Step 1 — try UDP broadcast on each target
    for (const target of DISCOVERY_TARGETS) {
      addLog(`Trying UDP ${target}...`)
      setStatus(`Trying ${target}...`)
      const found = await tryUDPDiscovery(payload, target)
      if (found) {
        discoveredIpRef.current = target
        setConnState('discovered')
        setStatus(`F56 found at ${target}\nTap Connect to start session.`)
        addLog(`Vehicle found via UDP at ${target}`)
        return
      }
    }

    // Step 2 — UDP failed, try direct TCP on common ZGW addresses
    addLog('UDP failed — trying direct TCP...')
    for (const target of TCP_TARGETS) {
      addLog(`Trying TCP ${target}...`)
      setStatus(`TCP ping ${target}...`)
      const reachable = await tryTCPPing(target)
      if (reachable) {
        discoveredIpRef.current = target
        setConnState('discovered')
        setStatus(`F56 found at ${target}\nTap Connect to start session.`)
        addLog(`Vehicle reachable via TCP at ${target}`)
        return
      }
    }

    setConnState('error')
    setStatus('No response.\n\nCheck:\n• Ignition ON\n• ENET cable in OBD2 port\n• Phone connected via ENET adapter')
    addLog('Discovery failed — no response from any target')
  }

  const tryUDPDiscovery = (payload, target) => {
    return new Promise((resolve) => {
      let resolved = false
      const finish = (result) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          resolve(result)
        }
      }

      const timer = setTimeout(() => finish(false), 2000)

      try {
        const udpClient = TcpSocket.createConnection(
          { host: target, port: DOIP_PORT, tls: false },
          () => { udpClient.write(payload) }
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

  const tryTCPPing = (target) => {
    return new Promise((resolve) => {
      let resolved = false
      const finish = (result) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          resolve(result)
        }
      }

      const timer = setTimeout(() => finish(false), 2000)

      try {
        const socket = TcpSocket.createConnection(
          { host: target, port: DOIP_PORT, tls: false },
          () => {
            socket.destroy()
            finish(true)
          }
        )
        socket.on('error', () => finish(false))
      } catch (e) {
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
    addLog(`TCP connecting to ${ip}:${DOIP_PORT}`)

    const socket = TcpSocket.createConnection(
      { host: ip, port: DOIP_PORT, tls: false },
      () => {
        addLog('TCP connected — sending Routing Activation...')
        socket.write(makeRoutingActivation())
      }
    )

    socket.on('data', (data) => {
      const bytes = Buffer.from(data)
      const hex = bytes.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')
      addLog(`RX: ${hex}`)

      // Routing Activation Response = payload type 0x0006
      if (bytes.length > 3 &&
          bytes[2] === 0x00 &&
          bytes[3] === 0x06) {
        addLog('Routing Activation successful!')
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
      setConnState('idle')
      setStatus('Connection closed.\nTap Discover to reconnect.')
    })

    socketRef.current = socket
  }

  // ── KEEPALIVE ─────────────────────────────────────────────

  const startKeepalive = (socket) => {
    if (keepaliveRef.current) clearInterval(keepaliveRef.current)
    keepaliveRef.current = setInterval(() => {
      try {
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

  // ── READ VIN ──────────────────────────────────────────────

  const readVIN = () => {
    if (!socketRef.current) return
    addLog('Requesting VIN (0x22 0xF190)...')
    socketRef.current.write(makeDoIPFrame([0x22, 0xF1, 0x90]))
  }

  // ── UI ────────────────────────────────────────────────────

  const stateColor = {
    idle:        '#666666',
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

      <Text style={styles.title}>Project F56</Text>

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
    backgroundColor: '#000000',
    padding: 16
  },
  title: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 16,
    marginTop: 8
  },
  card: {
    backgroundColor: '#111111',
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
    color: '#ffffff',
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
    backgroundColor: '#111111'
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
    borderColor: '#222222',
    padding: 12
  },
  logHeader: {
    color: '#444444',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 2,
    marginBottom: 8
  },
  logScroll: {
    flex: 1
  },
  logLine: {
    color: '#00ff00',
    fontSize: 11,
    fontFamily: 'Courier',
    lineHeight: 18
  }
})
