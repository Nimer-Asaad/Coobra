import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { CoobraRoot } from '@coobra/mobile-core';
import { appConfig } from '../config';

export default function RootLayout() {
  return (
    <CoobraRoot config={appConfig}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </CoobraRoot>
  );
}
