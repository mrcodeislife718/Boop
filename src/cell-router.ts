export type LedgerCell = {
  id: string;
  region: string;
  status: 'active' | 'draining' | 'offline';
  writeEndpoint: string;
};

export type AccountOwnership = {
  accountId: string;
  cellId: string;
  epoch: bigint;
  assignedAt: string;
};

export type CellRoute = {
  kind: 'local' | 'cross-cell';
  sourceCellId: string;
  destinationCellId: string;
  sourceEpoch: bigint;
  destinationEpoch: bigint;
};

export class LedgerCellRouter {
  private readonly cells = new Map<string, LedgerCell>();
  private readonly ownership = new Map<string, AccountOwnership>();

  registerCell(cell: LedgerCell): LedgerCell {
    if (!cell.id.trim() || !cell.region.trim() || !cell.writeEndpoint.trim()) throw new Error('Cell identity, region, and write endpoint are required');
    const copy = structuredClone(cell);
    this.cells.set(copy.id, copy);
    return structuredClone(copy);
  }

  assign(accountId: string, cellId: string): AccountOwnership {
    if (!accountId.trim()) throw new Error('accountId is required');
    const cell = this.requireCell(cellId);
    if (cell.status !== 'active') throw new Error(`Cannot assign account to ${cell.status} cell`);
    const prior = this.ownership.get(accountId);
    const next: AccountOwnership = {
      accountId,
      cellId,
      epoch: (prior?.epoch ?? 0n) + 1n,
      assignedAt: new Date().toISOString(),
    };
    this.ownership.set(accountId, next);
    return structuredClone(next);
  }

  migrate(accountId: string, destinationCellId: string, expectedEpoch: bigint): AccountOwnership {
    const current = this.requireOwnership(accountId);
    if (current.epoch !== expectedEpoch) throw new Error('Stale account ownership epoch');
    if (current.cellId === destinationCellId) return structuredClone(current);
    return this.assign(accountId, destinationCellId);
  }

  route(sourceAccountId: string, destinationAccountId: string, expectedSourceEpoch?: bigint, expectedDestinationEpoch?: bigint): CellRoute {
    const source = this.requireOwnership(sourceAccountId);
    const destination = this.requireOwnership(destinationAccountId);
    if (expectedSourceEpoch !== undefined && source.epoch !== expectedSourceEpoch) throw new Error('Stale source ownership epoch');
    if (expectedDestinationEpoch !== undefined && destination.epoch !== expectedDestinationEpoch) throw new Error('Stale destination ownership epoch');
    const sourceCell = this.requireCell(source.cellId);
    const destinationCell = this.requireCell(destination.cellId);
    if (sourceCell.status !== 'active' || destinationCell.status !== 'active') throw new Error('Account home cell is unavailable for writes');
    return {
      kind: source.cellId === destination.cellId ? 'local' : 'cross-cell',
      sourceCellId: source.cellId,
      destinationCellId: destination.cellId,
      sourceEpoch: source.epoch,
      destinationEpoch: destination.epoch,
    };
  }

  setCellStatus(cellId: string, status: LedgerCell['status']): void {
    this.requireCell(cellId).status = status;
  }

  getOwnership(accountId: string): AccountOwnership {
    return structuredClone(this.requireOwnership(accountId));
  }

  private requireCell(id: string): LedgerCell {
    const cell = this.cells.get(id);
    if (!cell) throw new Error(`Unknown ledger cell: ${id}`);
    return cell;
  }

  private requireOwnership(accountId: string): AccountOwnership {
    const ownership = this.ownership.get(accountId);
    if (!ownership) throw new Error(`No authoritative cell ownership for account: ${accountId}`);
    return ownership;
  }
}
