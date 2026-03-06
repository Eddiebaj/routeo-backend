import { StyleSheet, Text, View } from 'react-native';

export default function AlertsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Alerts</Text>
      <Text style={styles.sub}>LRT disruptions and service alerts coming soon</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0c0f', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: '#f0f2f5', marginBottom: 8 },
  sub: { fontSize: 14, color: '#6b7585' },
});