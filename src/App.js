import { Buffer } from 'buffer';
global.Buffer = Buffer;

import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, ScrollView, StatusBar } from 'react-native';
import TcpSocket from 'react-native-tcp-socket';

const DOIP_PORT = 6801; // Updated to your observed port
const TESTER = [0x0E, 0x80];
const DME = [0x00, 0x10];

export default function App() {
  const [status, setStatus] = useState('Plug in ENET and tap Discover.');
  const [connState, setConnState] = useState('idle');
  const [log, setLog] = useState([]);
  const socketRef = useRef(null);
  const keepaliveRef = useRef(null);

  const addLog = (line) => setLog(prev => [`[${new Date().toLocaleTimeString()}] ${line}`, ...prev].slice(0, 50));

  const buildFrame = (uds) => {
    const len = 4 + uds.length;
    return Buffer.from([0x02, 0xFD, 0x80, 0x01, 0x00, 0x00, (len >> 8) & 0xFF, len & 0xFF, ...TESTER, ...DME, ...uds]);
  };

  const discover = async () => {
    setConnState('discovering');
    addLog('Scanning for F56 on port ' + DOIP_PORT + '...');
    
    // Testing your specific identified IP
    const socket = TcpSocket.createConnection({ host: '169.254.111.49', port: DOIP_PORT, timeout: 2000 }, () => {
      socket.destroy();
      setConnState('discovered');
      setStatus('F56 found at 169.254.111.49');
      addLog('Connection verified on 6801.');
    });

    socket.on('error', (err) => {
      setConnState('error');
      setStatus('Not found. Check cable/IP.');
      addLog('Scan error: ' + err.message);
    });
  };

  const connect = () => {
    setConnState('connecting');
    const socket = TcpSocket.createConnection({ host: '169.254.111.49', port: DOIP_PORT }, () => {
      addLog('TCP open — sending Routing Activation');
      socket.write(Buffer.from([0x02, 0xFD, 0x00, 0x05, 0x00, 0x00, 0x00, 0x07, 0x0E, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00]));
    });

    socket.on('data', (data) => {
      addLog(`RX: ${data.toString('hex').toUpperCase()}`);
      if (data.length > 3 && data[3] === 0x06) {
        setConnState('connected');
        setStatus('Connected to F56');
        keepaliveRef.current = setInterval(() => socket.write(buildFrame([0x3E, 0x80])), 4000);
      }
    });

    socketRef.current = socket;
  };

  const sendCmd = (uds, label) => {
    addLog(label);
    socketRef.current?.write(buildFrame(uds));
  };

  useEffect(() => () => clearInterval(keepaliveRef.current), []);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>Project F56</Text>
      <View style={styles.card}><Text style={styles.status}>{status}</Text></View>
      
      <View style={styles.grid}>
        <Btn label="Discover" onPress={discover} disabled={connState !== 'idle'} />
        <Btn label="Connect" onPress={connect} disabled={connState !== 'discovered'} />
        <Btn label="VIN" onPress={() => sendCmd([0x22, 0xF1, 0x90], 'VIN Request')} disabled={connState !== 'connected'} />
        <Btn label="DTCs" onPress={() => sendCmd([0x19, 0x02, 0xFF], 'DTC Request')} disabled={connState !== 'connected'} />
      </View>

      <ScrollView style={styles.log}>
        {log.map((l, i) => <Text key={i} style={styles.logLine}>{l}</Text>)}
      </ScrollView>
    </SafeAreaView>
  );
}

const Btn = ({ label, onPress, disabled }) => (
  <TouchableOpacity style={[styles.btn, disabled && { opacity: 0.3 }]} onPress={onPress} disabled={disabled}>
    <Text style={styles.btnText}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 16 },
  title: { color: '#fff', fontSize: 20, textAlign: 'center', marginVertical: 16 },
  card: { padding: 20, backgroundColor: '#111', borderRadius: 12, marginBottom: 16 },
  status: { color: '#fff', textAlign: 'center', fontFamily: 'Courier' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: { flex: 1, minWidth: '45%', padding: 16, backgroundColor: '#222', borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600' },
  log: { flex: 1, marginTop: 16, backgroundColor: '#050505', padding: 10 },
  logLine: { color: '#0f0', fontSize: 10, fontFamily: 'Courier' }
});
