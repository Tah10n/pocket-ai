import { Redirect } from 'expo-router';
import { PerformanceScreen } from '../src/ui/screens/PerformanceScreen';

export default function PerformanceRoute() {
  if (typeof __DEV__ === 'undefined' || !__DEV__) {
    return <Redirect href="/(tabs)/settings" />;
  }

  return <PerformanceScreen />;
}
