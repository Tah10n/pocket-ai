import { getLlmContentPartSignatureEntry } from '../../src/utils/llmContentPartSignature';

describe('llmContentPartSignature', () => {
  it('does not include raw multimodal text, paths, or audio payloads in signature entries', () => {
    const privateText = 'Project for Client Omega includes a private address.';
    const privatePath = 'file:///private/var/mobile/Containers/Data/chat-attachments/private-audio.wav';
    const privateBase64 = `UklGR${'A'.repeat(96)}private-audio-payload`;

    const signatures = [
      getLlmContentPartSignatureEntry({ type: 'text', text: privateText }),
      getLlmContentPartSignatureEntry({ type: 'image_url', image_url: { url: privatePath } }),
      getLlmContentPartSignatureEntry({
        type: 'input_audio',
        input_audio: {
          format: 'wav',
          data: privateBase64,
        },
      }),
    ];
    const serialized = JSON.stringify(signatures);

    expect(serialized).toContain('text:');
    expect(serialized).toContain('image_url:');
    expect(serialized).toContain('input_audio:wav');
    expect(serialized).not.toContain(privateText);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain(privateBase64);
    expect(serialized).not.toContain('private-audio-payload');
  });

  it('distinguishes same-length audio payloads without storing either payload', () => {
    const firstPayload = `${'A'.repeat(64)}first`;
    const secondPayload = `${'B'.repeat(64)}other`;

    const firstSignature = getLlmContentPartSignatureEntry({
      type: 'input_audio',
      input_audio: {
        format: 'mp3',
        data: firstPayload,
      },
    });
    const secondSignature = getLlmContentPartSignatureEntry({
      type: 'input_audio',
      input_audio: {
        format: 'mp3',
        data: secondPayload,
      },
    });

    expect(firstPayload).toHaveLength(secondPayload.length);
    expect(firstSignature).not.toBe(secondSignature);
    expect(firstSignature).not.toContain(firstPayload);
    expect(secondSignature).not.toContain(secondPayload);
  });
});
