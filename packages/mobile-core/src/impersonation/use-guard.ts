import { useTranslation } from 'react-i18next';
import {
  impersonationRouteBlock,
  impersonationTransitionCapability,
  type ClassifiedRoute,
  type ImpersonationTargetRole,
  type ShipmentStatus,
} from '@coobra/shared';
import { useImpersonationStore } from './store';

/**
 * What this tab may do while acting as another account, from the shared policy tables the API
 * enforces (display only). Outside an impersonation everything is null: no change at all.
 */
export function useImpersonationGuard() {
  const { t } = useTranslation();
  const info = useImpersonationStore((state) => (state.mode === 'active' ? state.info : null));
  const writesEnabled = info?.writesEnabled ?? false;
  return {
    active: info !== null,
    writesEnabled,
    /** The translated reason a route is unavailable, or undefined when it may be used. */
    blockedReason(route: ClassifiedRoute): string | undefined {
      if (!info) return undefined;
      const block = impersonationRouteBlock(route, writesEnabled);
      return block ? t(`impersonation.blocked.${block}`) : undefined;
    },
    transition(role: ImpersonationTargetRole, from: ShipmentStatus, to: ShipmentStatus) {
      if (!info) return null;
      const capability = impersonationTransitionCapability(role, from, to, writesEnabled);
      return {
        ...capability,
        blockedReason: capability.block
          ? t(`impersonation.blocked.${capability.block}`)
          : undefined,
      };
    },
  };
}
