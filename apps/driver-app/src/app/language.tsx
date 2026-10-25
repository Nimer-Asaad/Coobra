import { router } from 'expo-router';
import { LanguageScreen } from '@coobra/mobile-core';

export default function LanguageRoute() {
  return <LanguageScreen onChosen={() => router.replace('/')} />;
}
