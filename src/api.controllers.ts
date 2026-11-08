import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
import { Response } from 'express';
import { HoldsService } from './holds/holds.service';
import { IdempotencyKey, IdempotentResult } from './ledger/idempotency.service';
import { LedgerService } from './ledger/ledger.service';
import { WalletsService } from './wallets/wallets.service';

const OWNER_ID = /^[A-Za-z0-9_-]+$/;

class CreateWalletDto {
  @ApiProperty({ example: 'trader-001' })
  @IsString() @Length(1, 64) @Matches(OWNER_ID)
  ownerId!: string;
}

class AmountDto {
  @ApiProperty({ example: '25.00', description: 'Decimal string, at most 2 decimal places. Never a JSON number.' })
  @IsString()
  amount!: string;
}

class TransferDto extends AmountDto {
  @ApiProperty({ example: 'trader-001' })
  @IsString() @Length(1, 64) @Matches(OWNER_ID)
  fromOwnerId!: string;

  @ApiProperty({ example: 'trader-002' })
  @IsString() @Length(1, 64) @Matches(OWNER_ID)
  toOwnerId!: string;
}

class CaptureDto {
  @ApiProperty({ example: 'trader-002' })
  @IsString() @Length(1, 64) @Matches(OWNER_ID)
  toOwnerId!: string;
}

const IdempotencyHeader = () =>
  ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Unique per logical operation; retries reuse it.' });

/** Sends the stored response for a replayed key, and marks it as a replay. */
function reply<T>(res: Response, result: IdempotentResult<T>): T {
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}

@ApiTags('wallets')
@Controller()
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post('wallets')
  create(@Body() dto: CreateWalletDto) {
    return this.wallets.create(dto.ownerId);
  }

  @Get('wallets/:ownerId')
  balances(@Param('ownerId') ownerId: string) {
    return this.wallets.balances(ownerId);
  }

  @Get('wallets/:ownerId/entries')
  history(@Param('ownerId') ownerId: string, @Query('limit') limit?: string) {
    return this.wallets.history(ownerId, limit ? Number.parseInt(limit, 10) || 50 : 50);
  }

  @Post('wallets/:ownerId/deposits')
  @IdempotencyHeader()
  async deposit(@IdempotencyKey() key: string, @Param('ownerId') ownerId: string, @Body() dto: AmountDto, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.wallets.deposit(key, ownerId, dto.amount));
  }

  @Post('wallets/:ownerId/withdrawals')
  @IdempotencyHeader()
  async withdraw(@IdempotencyKey() key: string, @Param('ownerId') ownerId: string, @Body() dto: AmountDto, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.wallets.withdraw(key, ownerId, dto.amount));
  }

  @Post('transfers')
  @IdempotencyHeader()
  async transfer(@IdempotencyKey() key: string, @Body() dto: TransferDto, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.wallets.transfer(key, dto.fromOwnerId, dto.toOwnerId, dto.amount));
  }
}

@ApiTags('holds')
@Controller()
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @Post('wallets/:ownerId/holds')
  @IdempotencyHeader()
  async place(@IdempotencyKey() key: string, @Param('ownerId') ownerId: string, @Body() dto: AmountDto, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.holds.place(key, ownerId, dto.amount));
  }

  @Post('holds/:holdId/capture')
  @IdempotencyHeader()
  async capture(@IdempotencyKey() key: string, @Param('holdId', ParseUUIDPipe) holdId: string, @Body() dto: CaptureDto, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.holds.capture(key, holdId, dto.toOwnerId));
  }

  @Post('holds/:holdId/release')
  @IdempotencyHeader()
  async release(@IdempotencyKey() key: string, @Param('holdId', ParseUUIDPipe) holdId: string, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.holds.release(key, holdId));
  }
}

@ApiTags('ledger')
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('invariants')
  @HttpCode(200)
  invariants() {
    return this.ledger.checkInvariants();
  }
}
