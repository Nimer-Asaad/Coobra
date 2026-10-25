import { useLocalSearchParams } from 'expo-router';
import { ResetPasswordScreen } from '@coobra/mobile-core';

export default function ResetPasswordRoute() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return <ResetPasswordScreen token={token} />;
}
