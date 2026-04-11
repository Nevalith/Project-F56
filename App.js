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
import UdpSocket from 'react-native-udp' // Added proper UDP library

const DOIP_PORT = 13400
const TESTER_ADDR = [0x0E, 0x80]
const DME_ADDR    = [0x00, 0x10]

export default function App() {
  const [status, setStatus]       = useState('Ready.\nPlug in ENET cable and tap Discover.')
  const [connState, setConnState] = useState('idle')
  const [log, setLog]              = useState([])

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
    const bodyLen = 4 + udsBytes.length // Length includes Tester & DME addr
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

  // ── DISCOVER (Proper UDP Broadcast) ──────────────────────────

  const discover = async () => {
    setConnState('discovering')
    setStatus('Broadcasting for F56...')
    addLog('Starting UDP Discovery...')

    const socket = UdpSocket.createSocket({ type: 'udp4' })
    socket.bind(0) 

    const payload = makeDiscoveryPayload()

    socket.on('message', (msg, rinfo) => {
      addLog(`Vehicle found! IP: ${rinfo.address}`)
      discoveredIpRef.current = rinfo.address
      setConnState('discovered')
      setStatus(`F56 found at ${rinfo.address}\nTap Connect.`)
      socket.close()
    })

    socket.on('error', (err) => {
      addLog(`UDP Error: ${err.message}`)
      socket.close()
    })

    // Broadcast to the APIPA subnet
    socket.send(payload, 0, payload.length, DOIP_PORT, '169.254.255.255', (err) => {
      if (err) addLog(`Send error: ${err.message}`)
    })

    // Timeout after 3 seconds
    setTimeout(() => {
      if (discoveredIpRef.current === null) {
        socket.close()
        setConnState('error')
        setStatus('Discovery failed.\nEnsure Ignition is ON.')
      }
    }, 3000)
  }

  // ── CONNECT (TCP Session) ───────────────────────────────────

  const connect = () => {
    const ip = discoveredIpRef.current
    if (!ip) return

    setConnState('connecting')
    setStatus(`Connecting to ${ip}...`)
    addLog(`TCP connecting to ${ip}:${DOIP_PORT}`)

    const socket = TcpSocket.createConnection(
      { host: ip, port: DOIP_PORT, tls: false },
      () => {
        addLog('TCP connected — activating routing...')
        socket.write(makeRoutingActivation())
      }
    )

    socket.on('data', (data) => {
      const bytes = Buffer.from(data)
      const hex = bytes.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')
      addLog(`RX: ${hex}`)

      if (bytes[3] === 0x06) {
        addLog('Routing Active!')
        setConnState('connected')
        setStatus('Connected to F56.')
        startKeepalive(socket)
      }
    })

    socket.on('error', (error) => {
      addLog(`Socket error: ${error.message}`)
      setConnState('error')
    })

    socketRef.current = socket
  }

  const startKeepalive = (socket) => {
    if (keepaliveRef.current) clearInterval(keepaliveRef.current)
    keepaliveRef.current = setInterval(() => {
      try {
        socket.write(makeDoIPFrame([0x3E, 0x80]))
      } catch (e) {
        clearInterval(keepaliveRef.current)
      }
    }, 4000)
  }

  const readVIN = () => {
    if (!socketRef.current) return
    addLog('Reading VIN...')
    socketRef.current.write(makeDoIPFrame([0x22, 0xF1, 0x90]))
  }

  const disconnect = () => {
    addLog('Disconnecting...')
    clearInterval(keepaliveRef.current)
    socketRef.current?.destroy()
    socketRef.current = null
    discoveredIpRef.current = null
    setConnState('idle')
  }

  // ── UI Logic (State mapping) ───────────────────────────────

  const stateColor = {
    idle: '#666666', discovering: '#FFD60A', discovered: '#0A84FF',
    connecting: '#FF9F0A', connected: '#30D158', error: '#FF453A'
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Project F56</Text>
      <View style={[styles.card, { borderColor: stateColor[connState] + '66' }]}>
        <Text style={[styles.stateLabel, { color: stateColor[connState] }]}>{connState.toUpperCase()}</Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>
      <View style={styles.buttons}>
        <ActionButton label="Discover F56" color="#0A84FF" onPress={discover} disabled={connState === 'connected'} />
        <ActionButton label="Connect" color="#30D158" onPress={connect} disabled={connState !== 'discovered'} />
        <ActionButton label="Read VIN" color="#FF9F0A" onPress={readVIN} disabled={connState !== 'connected'} />
        <ActionButton label="Disconnect" color="#FF453A" onPress={disconnect} disabled={connState !== 'connected'} />
      </View>
      <ScrollView style={styles.logContainer}><Text style={styles.logLine}>{log.join('\n')}</Text></ScrollView>
    </SafeAreaView>
  )
}

function ActionButton({ label, color, disabled, onPress }) {
  return (
    <TouchableOpacity 
      style={[styles.button, { borderColor: disabled ? color + '33' : color }]} 
      onPress={onPress} 
      disabled={disabled}
    >
      <Text style={[styles.buttonText, { color: disabled ? color + '44' : color }]}>{label}</Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 16 },
  title: { color: '#fff', fontSize: 20, textAlign: 'center', marginBottom: 16 },
  card: { backgroundColor: '#111', borderRadius: 12, borderWidth: 1, padding: 20, alignItems: 'center', marginBottom: 16 },
  stateLabel: { fontSize: 10, letterSpacing: 1, marginBottom: 8 },
  statusText: { color: '#fff', textAlign: 'center', fontFamily: 'Courier' },
  buttons: { gap: 10, marginBottom: 16 },
  button: { borderWidth: 1, borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { fontWeight: '600' },
  logContainer: { flex: 1, backgroundColor: '#050505', borderRadius: 8, padding: 10 },
  logLine: { color: '#00ff00', fontSize: 11, fontFamily: 'Courier' }
})
