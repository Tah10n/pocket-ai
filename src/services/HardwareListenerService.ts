import { AppState, NativeEventSubscription, Platform } from 'react-native';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export interface HardwareStatus {
    isLowMemory: boolean;
    networkType: string;
    isConnected: boolean;
    thermalState: ThermalState;
}

type Listener = (status: HardwareStatus) => void;

class HardwareListenerService {
    private listeners: Set<Listener> = new Set();
    private currentStatus: HardwareStatus = {
        isLowMemory: false,
        networkType: 'unknown',
        isConnected: true,
        thermalState: 'nominal',
    };

    private memoryWarningSub?: NativeEventSubscription;
    private netInfoUnsubscribe?: () => void;

    start() {
        this.memoryWarningSub = AppState.addEventListener('memoryWarning', this.handleMemoryWarning);
        this.netInfoUnsubscribe = NetInfo.addEventListener(this.handleNetworkChange);

        // Mocking thermal state for now as standard RN doesn't expose it directly without custom native modules.
        if (Platform.OS === 'ios') {
            // In a real implementation: subscribe to NSProcessInfoThermalStateDidChangeNotification
        }
    }

    stop() {
        this.memoryWarningSub?.remove();
        this.netInfoUnsubscribe?.();
    }

    subscribe(listener: Listener) {
        this.listeners.add(listener);
        listener(this.currentStatus);
        return () => this.listeners.delete(listener);
    }

    private handleMemoryWarning = () => {
        this.updateStatus({ isLowMemory: true });
        // Reset after some time assuming memory was freed
        setTimeout(() => {
            this.updateStatus({ isLowMemory: false });
        }, 5000);
    };

    private handleNetworkChange = (state: NetInfoState) => {
        this.updateStatus({
            networkType: state.type,
            isConnected: state.isConnected ?? false,
        });
    };

    private updateStatus(partialStatus: Partial<HardwareStatus>) {
        this.currentStatus = { ...this.currentStatus, ...partialStatus };
        this.listeners.forEach((listener) => listener(this.currentStatus));
    }

    getCurrentStatus() {
        return this.currentStatus;
    }
}

export const hardwareListenerService = new HardwareListenerService();
