import { EquipmentPiece, Player } from '@/types/Player';
import { Monster } from '@/types/Monster';
import { NPCVsPlayerCalculatedLoadout, PlayerVsNPCCalculatedLoadout } from '@/types/State';
import { CalcOpts } from '@/lib/BaseCalc';
import {
  CompareResult, CompareXAxis, CompareYAxis,
} from '@/lib/Comparator';
import {
  OptimizerJob, OptimizerOpts, OptimizerProgress, OptimizerResult,
} from '@/lib/optimizer';

/**
 * Requests
 */

export enum WorkerRequestType {
  COMPUTE_BASIC,
  COMPUTE_REVERSE,
  COMPUTE_TTK_PARALLEL,
  COMPUTE_TTK,
  COMPARE,
  OPTIMIZE_GEAR,
}

export interface WorkerRequest<T extends WorkerRequestType> {
  type: T,
  sequenceId?: number,
}

export interface WorkerCalcOpts {
  hitDistHideMisses?: boolean,
  detailedOutput?: CalcOpts['detailedOutput'],
  disableMonsterScaling?: CalcOpts['disableMonsterScaling'],
}

export interface ComputeBasicRequest extends WorkerRequest<WorkerRequestType.COMPUTE_BASIC> {
  data: {
    loadouts: Player[],
    monster: Monster,
    calcOpts: WorkerCalcOpts,
  }
}

export interface ComputeReverseRequest extends WorkerRequest<WorkerRequestType.COMPUTE_REVERSE> {
  data: {
    loadouts: Player[],
    monster: Monster,
    calcOpts: WorkerCalcOpts,
  }
}

export interface CompareRequest extends WorkerRequest<WorkerRequestType.COMPARE> {
  data: {
    axes: {
      x: CompareXAxis,
      y: CompareYAxis,
    },
    loadouts: Player[],
    monster: Monster,
  },
}

export interface TtkRequest extends WorkerRequest<WorkerRequestType.COMPUTE_TTK> {
  data: {
    loadouts: Player[],
    monster: Monster,
    calcOpts: WorkerCalcOpts,
  },
}

export interface TtkRequestParallel extends WorkerRequest<WorkerRequestType.COMPUTE_TTK_PARALLEL> {
  data: TtkRequest['data']
}

export interface OptimizeGearRequest extends WorkerRequest<WorkerRequestType.OPTIMIZE_GEAR> {
  data: {
    owned: EquipmentPiece[],
    player: Player,
    monster: Monster,
    opts: OptimizerOpts,
  },
}

export type CalcRequestsUnion =
  ComputeBasicRequest |
  ComputeReverseRequest |
  CompareRequest |
  TtkRequest |
  TtkRequestParallel |
  OptimizeGearRequest;

/**
 * Responses
 */

export interface WorkerResponse<T extends WorkerRequestType> {
  type: T,
  sequenceId: number,
  error?: string,
  payload: unknown,
}

export interface ComputeBasicResponse extends WorkerResponse<WorkerRequestType.COMPUTE_BASIC> {
  payload: Omit<PlayerVsNPCCalculatedLoadout, 'ttkDist'>[],
}

export interface ComputeReverseResponse extends WorkerResponse<WorkerRequestType.COMPUTE_REVERSE> {
  payload: NPCVsPlayerCalculatedLoadout[],
}

export interface CompareResponse extends WorkerResponse<WorkerRequestType.COMPARE> {
  payload: CompareResult,
}

export interface TtkResponse extends WorkerResponse<WorkerRequestType.COMPUTE_TTK> {
  payload: Pick<PlayerVsNPCCalculatedLoadout, 'ttkDist'>[],
}

export interface TtkResponseParallel extends WorkerResponse<WorkerRequestType.COMPUTE_TTK_PARALLEL> {
  payload: TtkResponse['payload'],
}

export interface OptimizeGearResponse extends WorkerResponse<WorkerRequestType.OPTIMIZE_GEAR> {
  payload: OptimizerResult,
}

/**
 * Sent by the worker while a long-running request (currently only gear optimization) is still in progress.
 */
export interface WorkerProgressMessage<T extends WorkerRequestType> {
  type: T,
  sequenceId: number,
  progress: unknown,
}

export interface OptimizeGearProgressMessage extends WorkerProgressMessage<WorkerRequestType.OPTIMIZE_GEAR> {
  progress: OptimizerProgress,
}

export type CalcProgressUnion = OptimizeGearProgressMessage;
export type CalcProgress<T extends WorkerRequestType> = Extract<CalcProgressUnion, { type: T }>['progress'];

export type CalcResponsesUnion =
  ComputeBasicResponse |
  ComputeReverseResponse |
  CompareResponse |
  TtkResponse |
  TtkResponseParallel |
  OptimizeGearResponse;
export type CalcResponse<T extends WorkerRequestType> = CalcResponsesUnion & { type: T };

export type Handler<T extends WorkerRequestType> = (data: Extract<CalcRequestsUnion, { type: T }>['data'], rawRequest: CalcRequestsUnion) => Promise<CalcResponse<T>['payload']>;

/**
 * Messages between the calc worker and the gear optimizer workers it runs in parallel (see OptimizerPool).
 */
export type OptimizerWorkerRequest =
  | { type: 'init', data: OptimizeGearRequest['data'] }
  | { type: 'job', id: number, job: OptimizerJob };

export type OptimizerWorkerResponse =
  | { type: 'progress', evaluations: number }
  | { type: 'result', id: number, result: unknown, evaluations: number }
  | { type: 'error', id: number, error: string };
