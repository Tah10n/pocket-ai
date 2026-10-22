import type { LlamaContext, ParallelStatus } from 'llama.rn';
import { llmEngineService } from '../../src/services/LLMEngineService';

const engine = llmEngineService as unknown as { setContext(context: LlamaContext | null): void };
const setContext = engine.setContext;

/** Upgrade existing lifecycle fixtures without replacing the real request ledger.
 * Admission is a separate Promise; the original deferred completion still owns
 * native execution and the original stop mock remains its acknowledgement.
 */
export function installQueuedCompletionContextFixture(): void {
  jest.spyOn(engine, 'setContext').mockImplementation(context => {
    if (context && !context.parallel) {
      let nextId = 0;
      let slots = 1;
      const live = new Set<number>();
      const parallel: Pick<LlamaContext['parallel'], 'enable' | 'disable' | 'configure' | 'completion' | 'getStatus' | 'subscribeToStatus'> = {
        enable: jest.fn(async config => { slots = config?.n_parallel ?? 1; return true; }),
        disable: jest.fn(async () => true),
        configure: jest.fn(async config => { slots = config.n_parallel ?? slots; return true; }),
        completion: jest.fn(async (params, callback) => {
          const requestId = nextId++;
          live.add(requestId);
          const promise = Promise.resolve().then(() => context.completion(params,
            data => callback?.(requestId, data))).finally(() => { live.delete(requestId); });
          void promise.catch(() => undefined);
          return { requestId, promise, stop: () => context.stopCompletion() };
        }),
        getStatus: jest.fn(async (): Promise<ParallelStatus> => ({ n_parallel: slots,
          active_slots: live.size, queued_requests: 0,
          requests: [...live].map(request_id => ({ request_id, type: 'completion', state: 'generating',
            prompt_length: 0, tokens_generated: 0, prompt_ms: 0, generation_ms: 0, tokens_per_second: 0 })) })),
        subscribeToStatus: jest.fn(async () => ({ remove: () => undefined })),
      };
      Object.defineProperty(context, 'parallel', { value: parallel, configurable: true });
    }
    setContext.call(engine, context);
  });
}
