/**
 * Model Factory IPC Handlers
 * Handles model training operations with LoRA/QLoRA for low GPU systems
 */

import { IpcMainInvokeEvent, ipcMain, BrowserWindow } from "electron";
import { db } from "@/db";
import { eq, desc } from "drizzle-orm";
import log from "electron-log";
import path from "path";
import fs from "fs/promises";
import { execSync, spawn, ChildProcess } from "child_process";
import { app } from "electron";

import type {
  ModelFactorySystemInfo,
  CreateTrainingJobParams,
  TrainingJobInfo,
  TrainingProgressEvent,
  ExportModelParams,
  ImportAdapterParams,
  AdapterInfo,
} from "../ipc_types";

import * as trainingStore from "@/lib/training_job_store";

const logger = log.scope("model_factory_handlers");

// Active training processes
const activeTrainingJobs = new Map<string, ChildProcess>();
/**
 * In-process cache of live job state.
 *
 * It stays because progress arrives as a stream of stdout lines and writing
 * every one to SQLite would be pointless churn — but it is now a cache in front
 * of `training_jobs`, not the record itself. Everything that has to survive a
 * restart goes to the table through `trainingStore`.
 */
const trainingJobProgress = new Map<string, TrainingJobInfo>();

// =============================================================================
// SYSTEM INFO
// =============================================================================

/**
 * Detect what this machine can actually train with.
 *
 * Exported because dataset_training_handlers had a second copy of this - its
 * comment even said "re-use the system detection from model_factory_handlers"
 * — which meant the python3 probing bug had to be fixed twice and the two
 * answers could disagree about the same machine.
 */
export async function detectSystemCapabilities(): Promise<ModelFactorySystemInfo> {
  const info: ModelFactorySystemInfo = {
    hasGPU: false,
    hasPython: false,
    hasTorch: false,
    torchCuda: false,
    hasTransformers: false,
    hasPeft: false,
    hasBitsAndBytes: false,
    hasDatasets: false,
    hasAccelerate: false,
    hasUnsloth: false,
    missingPackages: [],
    supportedMethods: [],
    blockers: {},
    recommendedMethod: "qlora",
    recommendedQuantization: "4bit",
    maxBatchSize: 1,
  };

  // Find an interpreter, and REMEMBER which one answered. Probing packages
  // with a different command than the one that worked is how this reported a
  // fully-installed machine as having nothing.
  for (const cmd of ["python", "python3"]) {
    try {
      const version = execSync(`${cmd} --version`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!/^Python 3/.test(version)) continue;
      info.hasPython = true;
      info.pythonCommand = cmd;
      info.pythonVersion = version.replace("Python ", "");
      break;
    } catch {
      // try the next name
    }
  }
  if (!info.hasPython) logger.warn("No Python 3 interpreter found");

  // Check GPU (NVIDIA)
  try {
    const nvidiaSmi = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", {
      encoding: "utf-8",
    }).trim();

    if (nvidiaSmi) {
      const [gpuName, vramStr] = nvidiaSmi.split(",").map((s) => s.trim());
      info.hasGPU = true;
      info.gpuName = gpuName;
      info.gpuVRAM = parseInt(vramStr, 10);

      try {
        const cudaVersion = execSync("nvcc --version", { encoding: "utf-8" });
        const match = cudaVersion.match(/release (\d+\.\d+)/);
        if (match) info.cudaVersion = match[1];
      } catch {
        // CUDA toolkit absent; the driver may still expose a usable GPU.
      }
    }
  } catch {
    // No NVIDIA GPU, or nvidia-smi not on PATH.
  }

  // Check Python packages, using the interpreter that actually answered.
  if (info.hasPython && info.pythonCommand) {
    const py = info.pythonCommand;

    const probe = (mod: string): boolean => {
      try {
        execSync(py + ' -c "import ' + mod + '"', {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return true;
      } catch {
        return false;
      }
    };

    info.hasTransformers = probe("transformers");
    info.hasPeft = probe("peft");
    info.hasBitsAndBytes = probe("bitsandbytes");
    info.hasDatasets = probe("datasets");
    info.hasAccelerate = probe("accelerate");
    info.hasUnsloth = probe("unsloth");

    // torch is asked directly whether it can see a GPU. nvidia-smi finding a
    // card proves nothing about the wheel that is installed: a CPU-only torch
    // on a machine with a 4090 still cannot run 4-bit QLoRA.
    try {
      const out = execSync(
        py +
          ' -c "import torch,json;print(json.dumps({\'v\':torch.__version__,\'cuda\':torch.cuda.is_available()}))"',
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      const parsed = JSON.parse(out);
      info.hasTorch = true;
      info.torchVersion = parsed.v;
      info.torchCuda = Boolean(parsed.cuda);
    } catch {
      // torch missing or unimportable
    }
  }

  // Name what is missing, so the UI can say what to install rather than
  // letting a job fail two minutes in with a Python traceback.
  if (!info.hasTorch) info.missingPackages.push("torch");
  if (!info.hasTransformers) info.missingPackages.push("transformers");
  if (!info.hasPeft) info.missingPackages.push("peft");
  if (!info.hasDatasets) info.missingPackages.push("datasets");
  if (!info.hasAccelerate) info.missingPackages.push("accelerate");
  if (!info.hasBitsAndBytes) info.missingPackages.push("bitsandbytes");

  const baseReady =
    info.hasPython &&
    info.hasTorch &&
    info.hasTransformers &&
    info.hasPeft &&
    info.hasDatasets &&
    info.hasAccelerate;

  if (!info.hasPython) {
    const msg = "Python 3 was not found on PATH";
    info.blockers.lora = msg;
    info.blockers.qlora = msg;
    info.blockers.full = msg;
  } else if (!baseReady) {
    const missing = info.missingPackages
      .filter((m) => m !== "bitsandbytes")
      .join(", ");
    const msg = "Missing Python packages: " + (missing || "none");
    info.blockers.lora = msg;
    info.blockers.qlora = msg;
    info.blockers.full = msg;
  } else if (!info.torchCuda) {
    // LoRA on CPU is legal but glacial; QLoRA is impossible, because 4-bit
    // quantisation is a bitsandbytes CUDA kernel.
    info.supportedMethods.push("lora");
    info.blockers.lora =
      "torch has no CUDA — LoRA will run on CPU and be extremely slow";
    info.blockers.qlora =
      "QLoRA needs a CUDA GPU: 4-bit quantisation is a bitsandbytes CUDA kernel";
    info.blockers.full = "Full fine-tuning needs a CUDA GPU";
  } else if (!info.hasBitsAndBytes) {
    info.supportedMethods.push("lora", "full");
    info.blockers.qlora = "bitsandbytes is not installed";
  } else {
    info.supportedMethods.push("lora", "qlora", "full");
  }


  // Determine recommended settings based on GPU VRAM
  if (info.hasGPU && info.gpuVRAM) {
    if (info.gpuVRAM >= 24000) {
      info.recommendedMethod = "lora";
      info.recommendedQuantization = "none";
      info.maxBatchSize = 8;
    } else if (info.gpuVRAM >= 16000) {
      info.recommendedMethod = "lora";
      info.recommendedQuantization = "8bit";
      info.maxBatchSize = 4;
    } else if (info.gpuVRAM >= 8000) {
      info.recommendedMethod = "qlora";
      info.recommendedQuantization = "4bit";
      info.maxBatchSize = 2;
    } else if (info.gpuVRAM >= 4000) {
      info.recommendedMethod = "qlora";
      info.recommendedQuantization = "4bit";
      info.maxBatchSize = 1;
    } else {
      info.recommendedMethod = "qlora";
      info.recommendedQuantization = "4bit";
      info.maxBatchSize = 1;
    }
  } else {
    // CPU only - use most memory-efficient settings
    info.recommendedMethod = "qlora";
    info.recommendedQuantization = "4bit";
    info.maxBatchSize = 1;
  }

  return info;
}

// =============================================================================
// TRAINING JOB MANAGEMENT
// =============================================================================

function generateJobId(): string {
  return `train_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getModelsDir(): string {
  return path.join(app.getPath("userData"), "models");
}

function getAdaptersDir(): string {
  return path.join(app.getPath("userData"), "adapters");
}

function getCheckpointsDir(): string {
  return path.join(app.getPath("userData"), "checkpoints");
}

async function ensureDirectories(): Promise<void> {
  await fs.mkdir(getModelsDir(), { recursive: true });
  await fs.mkdir(getAdaptersDir(), { recursive: true });
  await fs.mkdir(getCheckpointsDir(), { recursive: true });
}

// Generate Python training script
function generateTrainingScript(job: TrainingJobInfo, params: CreateTrainingJobParams): string {
  const outputDir = params.outputPath || path.join(getAdaptersDir(), job.id);
  const checkpointDir = path.join(getCheckpointsDir(), job.id);

  const use4bit = params.hyperparameters.use4bit ?? (params.method === "qlora");
  const use8bit = params.hyperparameters.use8bit ?? false;
  const gradientCheckpointing = params.hyperparameters.gradientCheckpointing ?? true;
  const loraRank = params.hyperparameters.loraRank ?? 16;
  const loraAlpha = params.hyperparameters.loraAlpha ?? 32;
  const loraDropout = params.hyperparameters.loraDropout ?? 0.05;

  return `
#!/usr/bin/env python3
"""
JoyCreate Model Training Script
Generated for job: ${job.id}
Method: ${params.method}
"""

import os
import sys
import json
import torch
from datetime import datetime

# Progress reporting
def report_progress(data):
    print(f"PROGRESS:{json.dumps(data)}", flush=True)

def report_error(message):
    print(f"ERROR:{message}", flush=True)

try:
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        TrainingArguments,
        Trainer,
        DataCollatorForLanguageModeling,
    )
    from datasets import load_dataset
    from peft import (
        LoraConfig,
        get_peft_model,
        prepare_model_for_kbit_training,
        TaskType,
    )
    ${use4bit || use8bit ? `
    from transformers import BitsAndBytesConfig
    ` : ''}
except ImportError as e:
    report_error(f"Missing dependency: {e}")
    sys.exit(1)

# Configuration
MODEL_ID = "${params.baseModelId}"
OUTPUT_DIR = "${outputDir.replace(/\\/g, '/')}"
CHECKPOINT_DIR = "${checkpointDir.replace(/\\/g, '/')}"
DATASET_PATH = "${params.datasetPath.replace(/\\/g, '/')}"
DATASET_FORMAT = "${params.datasetFormat}"

# Training hyperparameters
EPOCHS = ${params.hyperparameters.epochs}
BATCH_SIZE = ${params.hyperparameters.batchSize}
LEARNING_RATE = ${params.hyperparameters.learningRate}
LORA_RANK = ${loraRank}
LORA_ALPHA = ${loraAlpha}
LORA_DROPOUT = ${loraDropout}

# Memory optimization
USE_4BIT = ${use4bit ? 'True' : 'False'}
USE_8BIT = ${use8bit ? 'True' : 'False'}
USE_GRADIENT_CHECKPOINTING = ${gradientCheckpointing ? 'True' : 'False'}

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(CHECKPOINT_DIR, exist_ok=True)

report_progress({
    "status": "loading_model",
    "message": "Loading base model..."
})

# Quantization config
bnb_config = None
${use4bit ? `
bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,
)
` : use8bit ? `
bnb_config = BitsAndBytesConfig(
    load_in_8bit=True,
)
` : ''}

# Load model
model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    quantization_config=bnb_config,
    device_map="auto",
    trust_remote_code=True,
    torch_dtype=torch.bfloat16 if not (USE_4BIT or USE_8BIT) else None,
)

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

# Prepare for k-bit training
if USE_4BIT or USE_8BIT:
    model = prepare_model_for_kbit_training(model)

if USE_GRADIENT_CHECKPOINTING:
    model.gradient_checkpointing_enable()

report_progress({
    "status": "configuring_lora",
    "message": "Configuring LoRA adapter..."
})

# LoRA configuration
lora_config = LoraConfig(
    r=LORA_RANK,
    lora_alpha=LORA_ALPHA,
    lora_dropout=LORA_DROPOUT,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    bias="none",
    task_type=TaskType.CAUSAL_LM,
)

model = get_peft_model(model, lora_config)
model.print_trainable_parameters()

report_progress({
    "status": "loading_dataset",
    "message": "Loading and processing dataset..."
})

# Load dataset
if DATASET_PATH.endswith('.json') or DATASET_PATH.endswith('.jsonl'):
    dataset = load_dataset('json', data_files=DATASET_PATH)['train']
elif DATASET_PATH.endswith('.csv'):
    dataset = load_dataset('csv', data_files=DATASET_PATH)['train']
else:
    dataset = load_dataset(DATASET_PATH)['train']

# Format dataset based on format
def format_alpaca(example):
    if example.get('input'):
        text = f"### Instruction:\\n{example['instruction']}\\n\\n### Input:\\n{example['input']}\\n\\n### Response:\\n{example['output']}"
    else:
        text = f"### Instruction:\\n{example['instruction']}\\n\\n### Response:\\n{example['output']}"
    return {"text": text}

def format_sharegpt(example):
    conversations = example.get('conversations', [])
    text = ""
    for conv in conversations:
        role = conv.get('from', conv.get('role', ''))
        content = conv.get('value', conv.get('content', ''))
        if role in ['human', 'user']:
            text += f"### Human:\\n{content}\\n\\n"
        elif role in ['gpt', 'assistant']:
            text += f"### Assistant:\\n{content}\\n\\n"
    return {"text": text.strip()}

def format_raw(example):
    return {"text": example.get('text', str(example))}

if DATASET_FORMAT == 'alpaca':
    dataset = dataset.map(format_alpaca)
elif DATASET_FORMAT == 'sharegpt':
    dataset = dataset.map(format_sharegpt)
else:
    dataset = dataset.map(format_raw)

# Tokenize
def tokenize(example):
    result = tokenizer(
        example['text'],
        truncation=True,
        max_length=2048,
        padding=False,
    )
    result['labels'] = result['input_ids'].copy()
    return result

tokenized_dataset = dataset.map(tokenize, remove_columns=dataset.column_names)

# Training arguments
training_args = TrainingArguments(
    output_dir=CHECKPOINT_DIR,
    num_train_epochs=EPOCHS,
    per_device_train_batch_size=BATCH_SIZE,
    gradient_accumulation_steps=max(1, 4 // BATCH_SIZE),
    learning_rate=LEARNING_RATE,
    weight_decay=0.01,
    warmup_ratio=0.03,
    lr_scheduler_type="cosine",
    logging_steps=10,
    save_steps=100,
    save_total_limit=3,
    fp16=not USE_4BIT and torch.cuda.is_available(),
    bf16=USE_4BIT and torch.cuda.is_available(),
    optim="paged_adamw_8bit" if USE_4BIT else "adamw_torch",
    report_to=[],
    remove_unused_columns=False,
)

# Custom callback for progress reporting
from transformers import TrainerCallback

class ProgressCallback(TrainerCallback):
    def __init__(self):
        self.current_step = 0
        self.total_steps = 0
    
    def on_train_begin(self, args, state, control, **kwargs):
        self.total_steps = state.max_steps
        report_progress({
            "status": "training",
            "message": "Training started",
            "total_steps": self.total_steps,
            "total_epochs": args.num_train_epochs,
        })
    
    def on_step_end(self, args, state, control, **kwargs):
        self.current_step = state.global_step
        progress = (state.global_step / state.max_steps) * 100 if state.max_steps > 0 else 0
        
        loss = state.log_history[-1].get('loss', 0) if state.log_history else 0
        
        report_progress({
            "status": "training",
            "progress": progress,
            "current_step": state.global_step,
            "total_steps": state.max_steps,
            "current_epoch": state.epoch,
            "total_epochs": args.num_train_epochs,
            "loss": loss,
            "learning_rate": state.log_history[-1].get('learning_rate', LEARNING_RATE) if state.log_history else LEARNING_RATE,
        })
    
    def on_save(self, args, state, control, **kwargs):
        report_progress({
            "status": "saving_checkpoint",
            "message": f"Checkpoint saved at step {state.global_step}",
            "current_step": state.global_step,
        })

# Data collator
data_collator = DataCollatorForLanguageModeling(
    tokenizer=tokenizer,
    mlm=False,
)

# Trainer
trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=tokenized_dataset,
    data_collator=data_collator,
    callbacks=[ProgressCallback()],
)

report_progress({
    "status": "training",
    "message": "Starting training...",
    "total_epochs": EPOCHS,
})

# Train
trainer.train()

report_progress({
    "status": "saving",
    "message": "Saving adapter weights..."
})

# Save adapter
model.save_pretrained(OUTPUT_DIR)
tokenizer.save_pretrained(OUTPUT_DIR)

# Save training info
training_info = {
    "job_id": "${job.id}",
    "base_model": MODEL_ID,
    "method": "${params.method}",
    "lora_rank": LORA_RANK,
    "lora_alpha": LORA_ALPHA,
    "epochs": EPOCHS,
    "completed_at": datetime.now().isoformat(),
}

with open(os.path.join(OUTPUT_DIR, "training_info.json"), "w") as f:
    json.dump(training_info, f, indent=2)

report_progress({
    "status": "completed",
    "message": "Training completed successfully!",
    "output_path": OUTPUT_DIR,
})

print("Training completed successfully!")
`;
}

// =============================================================================
// IPC HANDLERS
// =============================================================================

export async function handleGetSystemInfo(): Promise<ModelFactorySystemInfo> {
  logger.info("Getting system capabilities for model training...");
  return await detectSystemCapabilities();
}

export async function handleCreateTrainingJob(
  _event: IpcMainInvokeEvent,
  params: CreateTrainingJobParams
): Promise<TrainingJobInfo> {
  logger.info("Creating training job:", params.name);
  
  await ensureDirectories();
  
  const jobId = generateJobId();
  const outputPath = params.outputPath || path.join(getAdaptersDir(), jobId);
  
  const job: TrainingJobInfo = {
    id: jobId,
    name: params.name,
    description: params.description,
    baseModelId: params.baseModelId,
    method: params.method,
    status: "queued",
    progress: 0,
    totalEpochs: params.hyperparameters.epochs,
    currentEpoch: 0,
    outputPath,
    createdAt: Date.now(),
  };
  
  trainingJobProgress.set(jobId, job);

  // Write through. A fine-tune runs for hours; a record that exists only in
  // this process is erased — not failed — the moment the app closes.
  try {
    trainingStore.createJob({
      id: jobId,
      name: params.name,
      description: params.description,
      baseModelId: params.baseModelId,
      method: params.method as trainingStore.TrainingMethod,
      datasetId: params.datasetPath,
      datasetPath: params.datasetPath,
      outputPath,
      totalEpochs: params.hyperparameters.epochs,
      hyperparameters: params.hyperparameters as Record<string, unknown>,
    });
  } catch (err) {
    // Losing the durable record is bad; refusing to train because of it is
    // worse — the user still gets their run, and the failure is on the record.
    logger.error("failed to persist training job:", err);
  }

  return job;
}

export async function handleStartTraining(
  _event: IpcMainInvokeEvent,
  jobId: string
): Promise<void> {
  const job = trainingJobProgress.get(jobId);
  if (!job) {
    throw new Error(`Training job not found: ${jobId}`);
  }
  
  logger.info("Starting training job:", jobId);

  // Refuse to start a run this machine cannot finish.
  //
  // Without this the app spawned python, the import of `peft` or
  // `bitsandbytes` failed, and the user got a Python traceback minutes later —
  // for a job they had been told was training. QLoRA is the sharp case: 4-bit
  // quantisation is a CUDA kernel, so on a CPU-only torch it can never work no
  // matter how long it is left running.
  const capabilities = await detectSystemCapabilities();
  const blocker = capabilities.blockers[job.method];
  const supported = capabilities.supportedMethods.includes(job.method);

  if (!supported) {
    const reason =
      blocker ?? `${job.method} is not available on this machine`;
    const install = capabilities.missingPackages.length
      ? ` Install: pip install ${capabilities.missingPackages.join(" ")}`
      : "";
    trainingStore.markFailed(jobId, `${reason}.${install}`);
    job.status = "failed";
    job.error = `${reason}.${install}`;
    throw new Error(`Cannot start ${job.method} training: ${reason}.${install}`);
  }

  if (blocker) {
    // Supported but degraded — CPU LoRA is the case. Worth saying out loud
    // rather than letting someone wonder why an epoch is taking all day.
    logger.warn(`Training job ${jobId} starting with a caveat: ${blocker}`);
  }
  
  // Create params from job info
  const params: CreateTrainingJobParams = {
    name: job.name,
    description: job.description,
    baseModelSource: "huggingface",
    baseModelId: job.baseModelId,
    method: job.method as any,
    datasetPath: "", // Will be set from job metadata
    datasetFormat: "alpaca",
    hyperparameters: {
      epochs: job.totalEpochs || 3,
      batchSize: 1,
      learningRate: 2e-4,
    },
    outputPath: job.outputPath,
  };
  
  // Generate and save training script
  const scriptPath = path.join(app.getPath("temp"), `train_${jobId}.py`);
  const script = generateTrainingScript(job, params);
  await fs.writeFile(scriptPath, script, "utf-8");
  
  // Start training process
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const proc = spawn(pythonCmd, [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
  });
  
  let lastPersistedEpoch = -1;
  activeTrainingJobs.set(jobId, proc);
  
  // Update status
  job.status = "training";
  job.startedAt = Date.now();
  trainingStore.markStarted(jobId, proc.pid);
  
  // Handle output
  proc.stdout?.on("data", (data: Buffer) => {
    const output = data.toString();
    
    // Parse progress updates
    const lines = output.split("\n");
    for (const line of lines) {
      if (line.startsWith("PROGRESS:")) {
        try {
          const progress = JSON.parse(line.substring(9));
          
          // Update job info
          job.status = progress.status || job.status;
          job.progress = progress.progress || job.progress;
          job.currentEpoch = progress.current_epoch || job.currentEpoch;
          job.currentStep = progress.current_step || job.currentStep;
          job.totalSteps = progress.total_steps || job.totalSteps;
          job.currentLoss = progress.loss || job.currentLoss;

          // Persisted on epoch boundaries rather than per stdout line: a run
          // emits thousands of progress lines, and the resolution that matters
          // after a crash is "which epoch", not "which step".
          if (
            progress.current_epoch !== undefined &&
            progress.current_epoch !== lastPersistedEpoch
          ) {
            lastPersistedEpoch = progress.current_epoch;
            trainingStore.recordProgress(jobId, {
              progress: job.progress,
              currentEpoch: job.currentEpoch,
              currentStep: job.currentStep,
              totalSteps: job.totalSteps,
              currentLoss:
                typeof job.currentLoss === "number"
                  ? Math.round(job.currentLoss * 10000)
                  : undefined,
            });
          }
          
          // Send event to renderer
          const windows = BrowserWindow.getAllWindows();
          for (const win of windows) {
            win.webContents.send("model-factory:training-progress", {
              jobId,
              ...progress,
            });
          }
        } catch (e) {
          logger.debug("Failed to parse progress:", line);
        }
      } else if (line.startsWith("ERROR:")) {
        job.error = line.substring(6);
        job.status = "failed";
      }
    }
  });
  
  proc.stderr?.on("data", (data: Buffer) => {
    logger.warn(`Training stderr [${jobId}]:`, data.toString());
  });
  
  proc.on("close", (code) => {
    activeTrainingJobs.delete(jobId);
    
    if (code === 0) {
      job.status = "completed";
      job.progress = 100;
      // Registers the adapter in `model_registry_entries`. Without this the
      // finished weights sat in a directory nothing referenced — "trained
      // models" reads that table, so hours of training produced something the
      // app could not see, use or publish.
      trainingStore.markCompleted(jobId);
    } else if (job.status !== "cancelled") {
      job.status = "failed";
      job.error = job.error || `Process exited with code ${code}`;
      trainingStore.markFailed(jobId, job.error);
    } else {
      trainingStore.markCancelled(jobId);
    }

    job.completedAt = Date.now();
    
    // Send completion event
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send("model-factory:training-completed", {
        jobId,
        status: job.status,
        outputPath: job.outputPath,
        error: job.error,
      });
    }
    
    // Cleanup script
    fs.unlink(scriptPath).catch(() => {});
  });
}

export async function handleCancelTraining(
  _event: IpcMainInvokeEvent,
  jobId: string
): Promise<void> {
  const proc = activeTrainingJobs.get(jobId);
  const job = trainingJobProgress.get(jobId);
  
  if (proc) {
    logger.info("Cancelling training job:", jobId);
    proc.kill("SIGTERM");
    activeTrainingJobs.delete(jobId);
  }
  
  if (job) {
    job.status = "cancelled";
    job.completedAt = Date.now();
  }
}

export async function handleGetTrainingJob(
  _event: IpcMainInvokeEvent,
  jobId: string
): Promise<TrainingJobInfo | null> {
  const live = trainingJobProgress.get(jobId);
  if (live) return live;
  // Not in this process — it may be from a previous session.
  const row = trainingStore.getJob(jobId);
  return row ? rowToJobInfo(row) : null;
}

export async function handleListTrainingJobs(): Promise<TrainingJobInfo[]> {
  // The table is the full history; the map holds only what this process
  // started. Listing just the map made every job from a previous session
  // disappear, which for multi-hour runs is most of them.
  const merged = new Map<string, TrainingJobInfo>();
  for (const row of trainingStore.listJobs()) merged.set(row.id, rowToJobInfo(row));
  for (const [id, live] of trainingJobProgress) merged.set(id, live);
  return Array.from(merged.values()).sort(
    (a, b) => b.createdAt - a.createdAt
  );
}

export async function handleExportModel(
  _event: IpcMainInvokeEvent,
  params: ExportModelParams
): Promise<string> {
  const job = trainingJobProgress.get(params.jobId);
  if (!job) {
    throw new Error(`Training job not found: ${params.jobId}`);
  }
  
  if (job.status !== "completed") {
    throw new Error("Training job is not completed");
  }
  
  logger.info("Exporting model:", params.jobId, "format:", params.format);
  
  // For GGUF export, we would need llama.cpp quantization
  // For now, return the adapter path
  const outputPath = params.outputPath || job.outputPath;
  
  if (params.format === "gguf" && params.mergeAdapter) {
    // TODO: Implement GGUF conversion with llama.cpp
    throw new Error("GGUF export not yet implemented. Use safetensors format.");
  }
  
  return outputPath || "";
}

export async function handleImportAdapter(
  _event: IpcMainInvokeEvent,
  params: ImportAdapterParams
): Promise<AdapterInfo> {
  logger.info("Importing adapter:", params.name, "from:", params.path);
  
  // Verify adapter path exists
  const stats = await fs.stat(params.path);
  if (!stats.isDirectory()) {
    throw new Error("Adapter path must be a directory");
  }
  
  // Check for adapter config
  const configPath = path.join(params.path, "adapter_config.json");
  let adapterConfig: any = {};
  
  try {
    const configData = await fs.readFile(configPath, "utf-8");
    adapterConfig = JSON.parse(configData);
  } catch {
    // Config not found, use defaults
  }
  
  // Calculate size
  let sizeBytes = 0;
  const files = await fs.readdir(params.path);
  for (const file of files) {
    const fileStat = await fs.stat(path.join(params.path, file));
    sizeBytes += fileStat.size;
  }
  
  const adapterId = `adapter_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const adapter: AdapterInfo = {
    id: adapterId,
    name: params.name,
    description: params.description,
    baseModelId: params.baseModelId,
    method: adapterConfig.peft_type || "lora",
    rank: adapterConfig.r,
    alpha: adapterConfig.lora_alpha,
    path: params.path,
    sizeBytes,
    createdAt: Date.now(),
  };
  
  return adapter;
}

export async function handleListAdapters(): Promise<AdapterInfo[]> {
  const adaptersDir = getAdaptersDir();
  
  try {
    const dirs = await fs.readdir(adaptersDir);
    const adapters: AdapterInfo[] = [];
    
    for (const dir of dirs) {
      const adapterPath = path.join(adaptersDir, dir);
      const stats = await fs.stat(adapterPath);
      
      if (stats.isDirectory()) {
        // Try to load adapter info
        try {
          const infoPath = path.join(adapterPath, "training_info.json");
          const infoData = await fs.readFile(infoPath, "utf-8");
          const info = JSON.parse(infoData);
          
          const configPath = path.join(adapterPath, "adapter_config.json");
          let config: any = {};
          try {
            const configData = await fs.readFile(configPath, "utf-8");
            config = JSON.parse(configData);
          } catch {}
          
          // Calculate size
          let sizeBytes = 0;
          const files = await fs.readdir(adapterPath);
          for (const file of files) {
            const fileStat = await fs.stat(path.join(adapterPath, file));
            sizeBytes += fileStat.size;
          }
          
          adapters.push({
            id: dir,
            name: info.job_id || dir,
            description: `Trained on ${info.base_model}`,
            baseModelId: info.base_model,
            method: info.method || config.peft_type || "lora",
            rank: info.lora_rank || config.r,
            alpha: info.lora_alpha || config.lora_alpha,
            path: adapterPath,
            sizeBytes,
            createdAt: stats.mtimeMs,
          });
        } catch {
          // Skip directories without valid info
        }
      }
    }
    
    return adapters.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function handleDeleteAdapter(
  _event: IpcMainInvokeEvent,
  adapterId: string
): Promise<void> {
  const adapterPath = path.join(getAdaptersDir(), adapterId);
  
  logger.info("Deleting adapter:", adapterId);
  
  await fs.rm(adapterPath, { recursive: true, force: true });
}

// =============================================================================
// REGISTER HANDLERS
// =============================================================================

export function registerModelFactoryHandlers() {
  logger.info("Registering model factory handlers...");
  
  ipcMain.handle("model-factory:get-system-info", handleGetSystemInfo);
  ipcMain.handle("model-factory:create-job", handleCreateTrainingJob);
  ipcMain.handle("model-factory:start-training", handleStartTraining);
  ipcMain.handle("model-factory:cancel-training", handleCancelTraining);
  ipcMain.handle("model-factory:get-job", handleGetTrainingJob);
  ipcMain.handle("model-factory:list-jobs", handleListTrainingJobs);
  ipcMain.handle("model-factory:export-model", handleExportModel);
  ipcMain.handle("model-factory:import-adapter", handleImportAdapter);
  ipcMain.handle("model-factory:list-adapters", handleListAdapters);
  ipcMain.handle("model-factory:delete-adapter", handleDeleteAdapter);
  
  logger.info("Model factory handlers registered");
}


/**
 * Adapt a persisted row to `TrainingJobInfo`, the shape every one of these
 * handlers already returns, so a job recovered from the table is
 * indistinguishable from a live one to every existing caller.
 */
function rowToJobInfo(row: trainingStore.TrainingJobRowLike): TrainingJobInfo {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    baseModelId: row.baseModelId,
    method: row.method,
    status: row.status,
    progress: row.progress ?? 0,
    currentEpoch: row.currentEpoch ?? undefined,
    totalEpochs: row.totalEpochs ?? undefined,
    currentStep: row.currentStep ?? undefined,
    totalSteps: row.totalSteps ?? undefined,
    // Stored as loss × 10000 to keep the column integral.
    currentLoss:
      typeof row.currentLoss === "number" ? row.currentLoss / 10000 : undefined,
    error: row.error ?? undefined,
    outputPath: row.outputPath ?? undefined,
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Date.now(),
    startedAt: row.startedAt instanceof Date ? row.startedAt.getTime() : undefined,
    completedAt:
      row.completedAt instanceof Date ? row.completedAt.getTime() : undefined,
  };
}
