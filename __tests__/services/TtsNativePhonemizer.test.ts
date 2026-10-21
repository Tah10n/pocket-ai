import { phonemizeSpeech } from '../../src/services/TtsPhonemizer';
import { split, restore } from '../../src/services/TtsPhonemizerFrontend';
const mockNative = { initialize: jest.fn(), convert: jest.fn(), cancel: jest.fn(), dispose: jest.fn() };
jest.mock('expo-modules-core', () => ({ requireNativeModule: jest.fn(() => mockNative) }));
const result = (raw: string[] = []) => ({ raw, initMs: 0, conversionMs: 0, calls: raw.length, offThread: true });
beforeEach(() => { jest.restoreAllMocks(); for(const f of Object.values(mockNative)) f.mockReset();
  mockNative.initialize.mockResolvedValue(result()); mockNative.cancel.mockResolvedValue(undefined);
  mockNative.convert.mockResolvedValue(result(['h_ə_l_ˈoʊ w_ˈɜː_l_d'])); });
it('uses async native phonemes and restores punctuation without the incompatible JS G2P',async()=>{
  await expect(phonemizeSpeech('Hello world!','en-us',()=>undefined)).resolves.toBe('həlˈoʊ wˈɜːld!');
  expect(mockNative.convert).toHaveBeenCalledWith(expect.any(String),['Hello world']);
});
it.each([['Hello.','ru'],['Привет.','en-us'],['x'.repeat(241),'en-us'],['bad\u0000','en-us']])('rejects text before native %s',async(text,language)=>{
  await expect(phonemizeSpeech(text,language,()=>undefined)).rejects.toThrow(); expect(mockNative.initialize).not.toHaveBeenCalled();
});
it('preserves apostrophes and hyphens without NFKC and skips C for punctuation-only input',async()=>{
  expect(split("Don't re-enter—“hello”! ").chunks).toEqual(["Don't re-enter",'hello']); expect(restore([],split('?!'))).toBe('?!');
  await expect(phonemizeSpeech('?!','en-us',()=>undefined)).resolves.toBe('?!'); expect(mockNative.initialize).not.toHaveBeenCalled();
});
it('cancels an outstanding conversion and waits for its actual drain',async()=>{
  const controller=new AbortController(); let settle!:(v:ReturnType<typeof result>)=>void;
  mockNative.convert.mockImplementation(()=>new Promise(resolve=>{settle=resolve;}));
  let finished=false; const pending=phonemizeSpeech('Hello.','en-us',()=>undefined,undefined,controller.signal).then(v=>{finished=true;return v;},e=>{finished=true;return e;});
  for(let i=0;i<20;i++) await Promise.resolve();
  if(!mockNative.convert.mock.calls.length){await pending;throw new Error('native conversion did not start');}
  controller.abort(); await Promise.resolve(); expect(mockNative.cancel).toHaveBeenCalledWith(mockNative.convert.mock.calls[0][0]); expect(finished).toBe(false);
  settle(result(['h_ə_l_ˈoʊ'])); expect(await pending).toMatchObject({code:'cancelled'});
});
it('rejects a competing utterance without queuing a native call',async()=>{
  let settle!:(v:ReturnType<typeof result>)=>void; mockNative.convert.mockImplementation(()=>new Promise(resolve=>{settle=resolve;}));
  const pending=phonemizeSpeech('Hello.','en-us',()=>undefined); for(let i=0;i<20;i++)await Promise.resolve();
  if(!mockNative.convert.mock.calls.length){await pending;throw new Error('native conversion did not start');}
  try{await expect(phonemizeSpeech('Other.','en-us',()=>undefined)).rejects.toMatchObject({code:'busy'});}finally{settle(result(['h_ə_l_ˈoʊ']));await pending;}
});
it('does not convert after initialization cancellation',async()=>{
  const c=new AbortController(); mockNative.initialize.mockImplementation(async()=>{c.abort();return result();});
  await expect(phonemizeSpeech('Hello.','en-us',()=>undefined,undefined,c.signal)).rejects.toMatchObject({code:'cancelled'}); expect(mockNative.convert).not.toHaveBeenCalled();
});
it.each(['data_missing','private text file:///sensitive'])('closes initialization errors %s',async error=>{
  mockNative.initialize.mockResolvedValue({...result(),error}); const failure=await phonemizeSpeech('Hello.','en-us',()=>undefined).catch(e=>e);
  expect(failure).toMatchObject({code:'phonemizer_failed',message:'phonemizer_failed',phonemizerFailure:{reason:'module_init'}});
  expect(JSON.stringify(failure)).not.toMatch(/private|sensitive|data_missing/);expect(mockNative.convert).not.toHaveBeenCalled();
});
it.each([{raw:[''],conversionMs:0},{raw:['x'.repeat(4097)],conversionMs:0},{raw:['bad\u0000'],conversionMs:0},{raw:['h_ə_l_ˈoʊ'],conversionMs:1001}])('rejects invalid or late settled output %#',async value=>{
  mockNative.convert.mockResolvedValue({...result(),...value});await expect(phonemizeSpeech('Hello.','en-us',()=>undefined)).rejects.toMatchObject({code:'phonemizer_failed'});
});
it('never starts native work after a superseding request invalidates the yield',async()=>{
  let active=true;const pending=phonemizeSpeech('Hello.','en-us',()=>{if(!active)throw new Error('cancelled');});active=false;
  await expect(pending).rejects.toThrow('cancelled');expect(mockNative.initialize).not.toHaveBeenCalled();
});
