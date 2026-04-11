import { Buffer } from 'buffer'
global.Buffer = Buffer

import React, { useState, useRef } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  StatusBar
} from 'react-native'
import TcpSocket from 'react-native-tcp-socket'

const DOIP_PORT   = 13400
const TESTER_ADDR = [0x0E, 0x80]
const DME_ADDR    = [0x00, 0x10]

// Full link-local subnet scan
const TCP_TARGETS = (() => {
  const targets = []
  for (let i = 0; i <= 255; i++) targets.push(`169.254.${i}.1`)
  for (let i = 0; i <= 255; i++) targets.push(`169.254.${i}.2`)
  for (let i = 0; i <= 255; i++) targets.push(`169.254.${i}.100`)
  return targets
})()

const UDP_TARGETS = [
  '169.254.255.255',
  '169.254.1.1',
  '169.254.0.1',
  '255.255.255.255'
]

export default function App() {
  const [status, setStatus]       = useState('Ready.\nPlug in ENET cable and tap Discover.')
  const [connState, setConnState] = useState('idle')
  const [log, setLog]             = useState([])

  const socketRef       = useRef(null)
  const discoveredIpRef = useRef(null)
  const keepaliveRef    = useRef(null)

  const addLog = (line) => {
    const ts = new Date().toLocaleTimeString()
    setLog(prev => [`[${ts}] ${line}`, ...prev].slice(0, 100))
  }

  // ── DoIP frame builders ──────────────────────────────────

  const makeDiscoveryPayload = () => Buffer.from([
    0x02, 0xFD, 0x00, 0x01,
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
    const bodyLen = 4 + udsBytes.length
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

  // ── Discovery ────────────────────────────────────────────

  const discover = async () => {
    setConnState('discovering')
    setStatus('Searching for F56...')
    addLog('Starting DoIP discovery...')

    // Step 1 — UDP broadcast
    for (const target of UDP_TARGETS) {
      addLog(`UDP → ${target}`)
      const found = await tryUDP(target)
      if (found) {
        discoveredIpRef.current = target
        setConnState('discovered')
        setStatus(`F56 found at ${target}\nTap Connect.`)
        addLog(`Found via UDP at ${target}`)
        return
      }
    }

    // Step 2 — TCP port scan entire 169.254.x.x
    addLog(`UDP failed. TCP scanning ${TCP_TARGETS.length} addresses...`)
    setStatus('Scanning network...\nThis takes ~2 minutes.')

    for (const target of TCP_TARGETS) {
      const alive = await tryTCPPing(target)
      if (alive) {
        discoveredIpRef.current = target
        setConnState('discovered')
        setStatus(`F56 found at ${target}\nTap Connect.`)
        addLog(`Found via TCP at ${target}`)
        return
      }
    }

    setConnState('error')
    setStatus('Not found.\n\nCheck:\n• Ignition ON\n• ENET cable in OBD2\n• ENET adapter in phone')
    addLog('Scan complete — no response')
  }

  const tryUDP = (target) => new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } }
    const t = setTimeout(() => finish(false), 2000)
    try {
      const s = TcpSocket.createConnection(
        { host: target, port: DOIP_PORT, tls: false },
        () => { s.write(makeDiscoveryPayload()) }
      )
      s.on('data', () => { s.destroy(); finish(true) })
      s.on('error', () => finish(false))
    } catch (e) { finish(false) }
  })

  const tryTCPPing = (target) => new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } }
    const t = setTimeout(() => finish(false), 500)
    try {
      const s = TcpSocket.createConnection(
        { host: target, port: DOIP_PORT, tls: false },
        () => { s.destroy(); finish(true) }
      )
      s.on('error', () => finish(false))
    } catch (e) { finish(false) }
  })

  // ── Connect ──────────────────────────────────────────────

  const connect = () => {
    const ip = discoveredIpRef.current
    if (!ip) return

    setConnState('connecting')
    setStatus(`Connecting to ${ip}...`)
    addLog(`TCP → ${ip}:${DOIP_PORT}`)

    const socket = TcpSocket.createConnection(
      { host: ip, port: DOIP_PORT, tls: false },
      () => {
        addLog('TCP open — sending Routing Activation')
        socket.write(makeRoutingActivation())
      }
    )

    socket.on('data', (data) => {
      const bytes = Buffer.from(data)
      const hex = bytes.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ')
      addLog(`RX: ${hex}`)

      if (bytes.length > 3 && bytes[2] === 0x00 && bytes[3] === 0x06) {
        addLog('Routing Activation OK!')
        setConnState('connected')
        setStatus(`Connected to F56.\nSession active.`)
        startKeepalive(socket)
      }
    })

    socket.on('error', (e) => {
      addLog(`Error: ${e.message}`)
      setConnState('error')
      setStatus(`Error:\n${e.message}`)
    })

    socket.on('close', () => {
      addLog('Socket closed')
      setConnState('idle')
      setStatus('Disconnected.')
    })

    socketRef.current = socket
  }

  // ── Keepalive ────────────────────────────────────────────

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

  // ── Disconnect ───────────────────────────────────────────

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

  // ── UDS commands ─────────────────────────────────────────

  const readVIN = () => {
    if (!socketRef.current) return
    addLog('Requesting VIN...')
    socketRef.current.write(makeDoIPFrame([0x22, 0xF1, 0x90]))
  }

  const readDTCs = () => {
    if (!socketRef.current) return
    addLog('Reading DTCs...')
    // UDS 0x19 0x02 0xFF = Read all stored DTCs
    socketRef.current.write(makeDoIPFrame([0x19, 0x02, 0xFF]))
  }

  // ── UI ───────────────────────────────────────────────────

  const STATE_COLOR = {
    idle:        '#666666',
    discovering: '#FFD60A',
    discovered:  '#0A84FF',
    connecting:  '#FF9F0A',
    connected:   '#30D158',
    error:       '#FF453A'
  }

  const STATE_LABEL = {
    idle:        'IDLE',
    discovering: 'SEARCHING',
    discovered:  'FOUND',
    connecting:  'CONNECTING',
    connected:   'CONNECTED',
    error:       'ERROR'
  }

  const color = STATE_COLOR[connState]

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      <Text style={styles.title}>Project F56</Text>

      {/* Status card */}
      <View style={[styles.card, { borderColor: color + '66' }]}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={[styles.stateLabel, { color }]}>
          {STATE_LABEL[connState]}
        </Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {/* Buttons */}
      <View style={styles.buttonGrid}>
        <Btn
          label="Discover"
          color="#0A84FF"
          disabled={connState === 'connecting' || connState === 'connected'}
          onPress={discover}
        />
        <Btn
          label="Connect"
          color="#30D158"
          disabled={connState !== 'discovered'}
          onPress={connect}
        />
        <Btn
          label="Read VIN"
          color="#FF9F0A"
          disabled={connState !== 'connected'}
          onPress={readVIN}
        />
        <Btn
          label="Read DTCs"
          color="#BF5AF2"
          disabled={connState !== 'connected'}
          onPress={readDTCs}
        />
        <Btn
          label="Disconnect"
          color="#FF453A"
          disabled={connState !== 'connected'}
          onPress={disconnect}
        />
      </View>

      {/* Log */}
      <View style={styles.logBox}>
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

function Btn({ label, color, disabled, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.btn, { borderColor: disabled ? color + '30' : color + '90' }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={[styles.btnText, { color: disabled ? color + '40' : color }]}>
        {label}
      </Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#000', padding: 16 },
  title:       { color: '#fff', fontSize: 20, fontWeight: '600', textAlign: 'center', marginBottom: 16 },
  card:        { backgroundColor: '#111', borderRadius: 16, borderWidth: 1, padding: 20, alignItems: 'center', marginBottom: 12 },
  dot:         { width: 8, height: 8, borderRadius: 4, marginBottom: 6 },
  stateLabel:  { fontSize: 11, fontWeight: '600', letterSpacing: 1.5, marginBottom: 6 },
  statusText:  { color: '#fff', fontSize: 13, textAlign: 'center', fontFamily: 'Courier', lineHeight: 20 },
  buttonGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  btn:         { borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', backgroundColor: '#111', minWidth: '30%', flex: 1 },
  btnText:     { fontSize: 13, fontWeight: '600' },
  logBox:      { flex: 1, backgroundColor: '#0a0a0a', borderRadius: 12, borderWidth: 1, borderColor: '#1a1a1a', padding: 10 },
  logHeader:   { color: '#333', fontSize: 10, fontWeight: '600', letterSpacing: 2, marginBottom: 6 },
  logScroll:   { flex: 1 },
  logLine:     { color: '#00ff00', fontSize: 10, fontFamily: 'Courier', lineHeight: 16 }
})
