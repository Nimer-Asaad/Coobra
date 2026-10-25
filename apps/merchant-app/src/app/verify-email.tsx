import { useLocalSearchParams } from 'expo-router';
import { VerifyEmailScreen } from '@coobra/mobile-core';

export default function VerifyEmailRoute() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return <VerifyEmailScreen token={token} />;
}
