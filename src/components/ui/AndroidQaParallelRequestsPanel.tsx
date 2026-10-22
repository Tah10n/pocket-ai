import React, { useState, useSyncExternalStore } from 'react';
import { Modal, ScrollView } from 'react-native';
import { Box } from './box';
import { Text } from './text';
import { Button, ButtonText } from './button';
import { getAndroidQaParallelRequestsEvidence, subscribeAndroidQaParallelRequests,
  isAndroidQaParallelRequestsEnabled, runAndroidQaParallelRequests } from '../../services/AndroidQaParallelRequests';

/** Fixed developer controls; ordinary packages never expose this untranslated QA surface. */
export function AndroidQaParallelRequestsPanel() {
  const [open, setOpen] = useState(false);
  const evidence = useSyncExternalStore(subscribeAndroidQaParallelRequests,
    getAndroidQaParallelRequestsEvidence, getAndroidQaParallelRequestsEvidence);
  if (!isAndroidQaParallelRequestsEnabled()) return null;
  const busy = evidence.status === 'running' || evidence.requiresForceStop;
  return <>
    <Button size="xs" action="secondary" testID="chat-qa-parallel-toggle" onPress={() => setOpen(true)}>
      <ButtonText>QA parallel requests</ButtonText>
    </Button>
    <Modal visible={open} transparent animationType="none" onRequestClose={() => { if (!busy) setOpen(false); }}>
      <Box className="flex-1 justify-center bg-background-0/90 px-6">
        <ScrollView style={{ flexGrow: 0 }}><Box className="gap-3 rounded-2xl border border-outline-200 bg-background-50 p-4">
          <Text colorRole="primary" className="text-lg font-semibold">QA parallel requests</Text>
          <Text colorRole="secondary" className="text-sm">{evidence.phase}</Text>
          <Text colorRole="secondary" className="text-sm">Load the pinned CPU text fixture first. Auxiliary QA requires its LoRA and selected pinned embedding/reranker files.</Text>
          <Box accessible collapsable={false} testID="chat-qa-parallel-evidence"
            accessibilityLabel={JSON.stringify(evidence)} className="h-1" />
          <Button size="sm" action="secondary" testID="chat-qa-parallel-single" disabled={busy}
            onPress={() => void runAndroidQaParallelRequests('single')}><ButtonText>QA one slot: queued/running Stop</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-parallel-compare" disabled={busy}
            onPress={() => void runAndroidQaParallelRequests('compare')}><ButtonText>QA sequential / two-slot timings</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-parallel-stop-one" disabled={busy}
            onPress={() => void runAndroidQaParallelRequests('stop_one')}><ButtonText>QA stop one, preserve the other</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-parallel-prepare-auxiliary" disabled={busy}
            onPress={() => void runAndroidQaParallelRequests('prepare_auxiliary')}><ButtonText>QA download pinned auxiliary files / apply LoRA</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-parallel-auxiliary" disabled={busy}
            onPress={() => void runAndroidQaParallelRequests('auxiliary')}><ButtonText>QA queued retrieval / LoRA restore</ButtonText></Button>
          <Text colorRole="secondary" className="text-xs">Each run exports stage8-parallel-mode.json in the isolated package cache. Choosing an answer in the ordinary chat UI is a separate check.</Text>
          <Button size="sm" action="secondary" testID="chat-qa-parallel-close" disabled={busy}
            onPress={() => setOpen(false)}><ButtonText>Close QA</ButtonText></Button>
        </Box></ScrollView>
      </Box>
    </Modal>
  </>;
}
