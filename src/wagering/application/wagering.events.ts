import { IntegrationEvent, IntegrationEventProps } from "../../shared/application/integration-event";
import { MoneyProps } from "../../shared/domain/money";

export interface WagerTransactionResultData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  balance: MoneyProps;
  failureCode: string | undefined;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionResultData> {
  override readonly eventType = "WagerTransactionProcessed";
  override readonly version = 1;

  constructor(props: IntegrationEventProps<WagerTransactionResultData>) {
    super(props);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionResultData> {
  override readonly eventType = "WagerTransactionRejected";
  override readonly version = 1;

  constructor(props: IntegrationEventProps<WagerTransactionResultData>) {
    super(props);
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  override readonly eventType = "WalletBalanceChanged";
  override readonly version = 1;

  constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionResultData> {
  override readonly eventType = "WagerTransactionPendingReference";
  override readonly version = 1;

  constructor(props: IntegrationEventProps<WagerTransactionResultData>) {
    super(props);
  }
}
