/** Durable background prompt batches share the validation/one-repair path of single shots. */
import { latestVideoPromptBatch, startVideoPromptBatchJob } from './agent-jobs.js'
export const startVideoPromptBatch = startVideoPromptBatchJob
export const getVideoPromptBatchStatus = latestVideoPromptBatch
