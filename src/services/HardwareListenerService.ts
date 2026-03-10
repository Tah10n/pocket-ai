import { AppState, NativeEventSubscription } from 'react-native';
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

    private started = false;
    private memoryWarningSub?: NativeEventSubscription;
    private netInfoUnsubscribe?: () => void;

    start() {
        if (this.started) return;
        this.started = true;

        this.memoryWarningSub = AppState.addEventListener('memoryWarning', this.handleMemoryWarning);
        this.netInfoUnsubscribe = NetInfo.addEventListener(this.handleNetworkChange);

        // NOTE: In a production app with New Architecture, 
        // thermal state should be provided via a TurboModule or NitroModule.
    }

    stop() {
        if (!this.started) return;
        this.started = false;

        this.memoryWarningSub?.remove();
        this.memoryWarningSub = undefined;
        this.netInfoUnsubscribe?.();
        this.netInfoUnsubscribe = undefined;
    }

    subscribe(listener: Listener) {
        this.listeners.add(listener);
        listener(this.currentStatus);
        return () => this.listeners.delete(listener);
    }

    /**
     * Manually reset the low memory flag. 
     * Usually called after a model is successfully unloaded.
     */
    resetLowMemoryFlag() {
        this.updateStatus({ isLowMemory: false });
    }

    private handleMemoryWarning = () => {
        console.warn('[HardwareListener] System memory warning received!');
        this.updateStatus({ isLowMemory: true });
        // We no longer use setTimeout to reset. 
        // The consumer (e.g. LLMEngineService) should handle unloading 
        // and then we can reset the flag if needed, or wait for next GC.
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

    /**
     * Set thermal state from native side (e.g. via TurboModule callback)
     */
    setThermalState(state: ThermalState) {
        this.updateStatus({ thermalState: state });
    }
}

export const hardwareListenerService = new HardwareListenerService();
