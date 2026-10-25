import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { SHIPMENT_STATUSES, type ShipmentStatus } from '@coobra/shared';
import { useMobileConfig } from '../config';
import { AppButton } from '../ui/button';
import { ErrorBanner } from '../ui/error-banner';
import { AppText } from '../ui/text';
import { TextField } from '../ui/text-field';
import { colors, spacing } from '../ui/theme';
import { useShipmentList } from './api';
import { ChipBar, EmptyState, ShipmentCard } from './components';

function useDebounced(value: string, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** "My shipments" for merchants (search + status filter) and drivers (active / history). */
export function ShipmentsListScreen() {
  const { t } = useTranslation();
  const { clientApp } = useMobileConfig();
  const isDriver = clientApp === 'DRIVER_APP';
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [status, setStatus] = useState<ShipmentStatus | 'ALL'>('ALL');
  const [scope, setScope] = useState<'active' | 'history'>('active');

  const list = useShipmentList({
    q: q || undefined,
    status: status === 'ALL' ? undefined : status,
    scope: isDriver ? scope : undefined,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const filtered = Boolean(q) || status !== 'ALL';

  const header = (
    <View style={styles.header}>
      {!isDriver ? (
        <AppButton
          title={t('shipments.newShipment')}
          onPress={() => router.push('/shipments/new')}
          testID="shipments-new"
        />
      ) : (
        <ChipBar
          options={[
            { value: 'active', label: t('shipments.driver.active') },
            { value: 'history', label: t('shipments.driver.history') },
          ]}
          value={scope}
          onChange={setScope}
        />
      )}
      <TextField
        label={t('shipments.search')}
        value={search}
        onChangeText={setSearch}
        placeholder={t('shipments.searchPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        testID="shipments-search"
      />
      {!isDriver ? (
        <ChipBar
          options={[
            { value: 'ALL' as const, label: t('shipments.filters.allStatuses') },
            ...SHIPMENT_STATUSES.map((value) => ({
              value,
              label: t(`shipmentStatus.${value}`),
            })),
          ]}
          value={status}
          onChange={setStatus}
        />
      ) : null}
      <ErrorBanner error={list.error} />
      {list.data ? (
        <AppText variant="muted">{t('shipments.total', { count: total })}</AppText>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ShipmentCard
            shipment={item}
            onPress={() => router.push({ pathname: '/shipments/[id]', params: { id: item.id } })}
          />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={
          list.isPending ? (
            <ActivityIndicator color={colors.primary} style={styles.loading} />
          ) : list.isError ? undefined : (
            <EmptyState
              message={
                filtered
                  ? t('shipments.noResults')
                  : isDriver
                    ? scope === 'active'
                      ? t('shipments.driver.emptyActive')
                      : t('shipments.driver.emptyHistory')
                    : t('shipments.empty')
              }
            />
          )
        }
        ListFooterComponent={
          list.hasNextPage ? (
            <AppButton
              variant="outline"
              title={t('shipments.loadMore')}
              loading={list.isFetchingNextPage}
              onPress={() => void list.fetchNextPage()}
            />
          ) : undefined
        }
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching && !list.isFetchingNextPage}
            onRefresh={() => void list.refetch()}
            tintColor={colors.primary}
          />
        }
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  header: { gap: spacing.md, marginBottom: spacing.xs },
  loading: { marginTop: spacing.xxl },
});
