import type { RemoteRelayOverviewDto } from '../../shared/contracts'

export function relayAccountName(
  account: RemoteRelayOverviewDto['account'],
): string {
  return account.username?.trim() || account.displayName.trim() || '已登录用户'
}
