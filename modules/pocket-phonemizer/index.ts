/** Native work settles only after its C call has drained, including cancellation. */
export interface NativePhonemizerResult {
  raw: string[];
  initMs: number;
  conversionMs: number;
  calls: number;
  offThread: boolean;
  error?: string;
}
export interface PocketPhonemizerNativeModule {
  initialize(): Promise<NativePhonemizerResult>;
  convert(requestId: string, chunks: string[]): Promise<NativePhonemizerResult>;
  cancel(requestId: string): Promise<void>;
  dispose(): Promise<void>;
}
// Loaded lazily by the owning service; importing types does not load the native library.
