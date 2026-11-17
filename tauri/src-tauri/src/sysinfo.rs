use serde_json::{json, Value};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const FULL_TICK: Duration = Duration::from_millis(1500);
const LIGHT_TICK: Duration = Duration::from_secs(5);
const GIB: f64 = 1_073_741_824.0;

#[derive(Default)]
struct Workers {
    full: Option<Arc<AtomicBool>>,
    light: Option<Arc<AtomicBool>>,
}

fn workers() -> &'static Mutex<Workers> {
    static WORKERS: OnceLock<Mutex<Workers>> = OnceLock::new();
    WORKERS.get_or_init(|| Mutex::new(Workers::default()))
}

fn latest() -> &'static RwLock<Value> {
    static LATEST: OnceLock<RwLock<Value>> = OnceLock::new();
    LATEST.get_or_init(|| RwLock::new(Value::Null))
}

fn without_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn publish(value: Value) {
    *latest()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
}

fn sleep_until_next_tick(stop: &AtomicBool, duration: Duration) -> bool {
    let mut remaining = duration;
    while remaining > Duration::ZERO {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        let step = remaining.min(Duration::from_millis(100));
        thread::sleep(step);
        remaining -= step;
    }
    !stop.load(Ordering::Acquire)
}

fn disk_info() -> Vec<Value> {
    ::sysinfo::Disks::new_with_refreshed_list()
        .list()
        .iter()
        .filter_map(|disk| {
            let total = disk.total_space();
            if total == 0 || (total as f64) <= GIB {
                return None;
            }
            let available = disk.available_space();
            let used_pct = 100.0 * (1.0 - available as f64 / total as f64);
            let mount = disk.mount_point().to_string_lossy();
            let drive = mount.trim_end_matches(['\\', '/']).trim_end_matches(':');
            Some(json!({
                "drive": if drive.is_empty() { mount.as_ref() } else { drive },
                "usedPct": used_pct,
                "totalGB": total as f64 / GIB
            }))
        })
        .collect()
}

fn cpu_frequency_mhz(system: &::sysinfo::System) -> Value {
    system
        .cpus()
        .iter()
        .map(|cpu| cpu.frequency())
        .find(|frequency| *frequency > 0)
        .map_or(Value::Null, |frequency| json!(frequency))
}

fn ram_speed_mhz() -> Value {
    static RAM_SPEED: OnceLock<Option<u32>> = OnceLock::new();
    match RAM_SPEED.get_or_init(|| {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Speed -Maximum).Maximum",
        ]);
        without_window(&mut command);
        let output = command.output().ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|speed| *speed > 0)
    }) {
        Some(speed) => json!(speed),
        None => Value::Null,
    }
}

fn parse_number(field: Option<&&str>) -> Option<f64> {
    field?.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

fn nvidia_gpu() -> Value {
    let mut command = Command::new("nvidia-smi");
    command.args([
        "--query-gpu=utilization.gpu,clocks.sm,clocks.mem,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]);
    without_window(&mut command);
    let output = match command.output() {
        Ok(output) if output.status.success() => output,
        _ => return Value::Null,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 6 {
            continue;
        }
        let parsed = [
            parse_number(fields.get(0)),
            parse_number(fields.get(1)),
            parse_number(fields.get(2)),
            parse_number(fields.get(3)),
            parse_number(fields.get(4)),
            parse_number(fields.get(5)),
        ];
        if parsed.iter().all(Option::is_some) {
            return json!({
                "util": parsed[0],
                "clockMHz": parsed[1],
                "memClockMHz": parsed[2],
                "memUsedMB": parsed[3],
                "memTotalMB": parsed[4],
                "tempC": parsed[5]
            });
        }
    }
    Value::Null
}

fn sample(
    system: &mut ::sysinfo::System,
    light: bool,
    extended: bool,
    cpu_ready: bool,
) -> Value {
    system.refresh_memory();
    system.refresh_cpu();
    let cpu = if cpu_ready {
        json!(system.global_cpu_info().cpu_usage())
    } else {
        Value::Null
    };
    let total = system.total_memory();
    let (mem_total_gb, mem_used_gb) = if total == 0 {
        (Value::Null, Value::Null)
    } else {
        (
            json!(total as f64 / GIB),
            json!(system.used_memory() as f64 / GIB),
        )
    };

    let disks = if light {
        Value::Null
    } else {
        json!(disk_info())
    };
    let gpu = if extended { nvidia_gpu() } else { Value::Null };
    let cpu_freq_mhz = if extended {
        cpu_frequency_mhz(system)
    } else {
        Value::Null
    };
    let ram_speed_mhz = if extended { ram_speed_mhz() } else { Value::Null };
    let ready = extended && gpu.is_object();

    json!({
        "cpu": cpu,
        "memTotalGB": mem_total_gb,
        "memUsedGB": mem_used_gb,
        "disks": disks,
        "gpu": gpu,
        "cpuFreqMHz": cpu_freq_mhz,
        "ramSpeedMHz": ram_speed_mhz,
        "light": light,
        "ready": ready
    })
}

fn worker_loop(app: AppHandle, stop: Arc<AtomicBool>, light: bool) {
    let mut system = ::sysinfo::System::new_all();
    let mut first = true;

    // 轻量模式先等出差分窗口；完整模式立刻发一帧（CPU 首帧为 null）。
    if light && !sleep_until_next_tick(&stop, FULL_TICK) {
        return;
    }

    loop {
        if stop.load(Ordering::Acquire) {
            return;
        }
        let value = sample(&mut system, light, !light, !first || light);
        publish(value.clone());
        if !stop.load(Ordering::Acquire) {
            let _ = app.emit("sysinfo", value);
        }
        first = false;
        let tick = if light { LIGHT_TICK } else { FULL_TICK };
        if !sleep_until_next_tick(&stop, tick) {
            return;
        }
    }
}

fn start(app: AppHandle, light: bool) -> Value {
    let mut workers = workers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slot = if light {
        &mut workers.light
    } else {
        &mut workers.full
    };
    if slot.is_some() {
        return json!({ "ok": true });
    }

    let stop = Arc::new(AtomicBool::new(false));
    *slot = Some(Arc::clone(&stop));
    thread::spawn(move || worker_loop(app, stop, light));
    json!({ "ok": true })
}

#[tauri::command]
pub fn sysinfo_get() -> Value {
    let cached = latest()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if !cached.is_null() {
        return cached;
    }

    // 与原版 latest() || sample() 一致；首次同步采样不做外部 GPU/CIM 查询。
    sample(&mut ::sysinfo::System::new_all(), false, false, false)
}

#[tauri::command]
pub fn sysinfo_start(app: AppHandle) -> Value {
    start(app, false)
}

#[tauri::command]
pub fn sysinfo_start_light(app: AppHandle) -> Value {
    start(app, true)
}

#[tauri::command]
pub fn sysinfo_stop() -> Value {
    let stop = workers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .full
        .take();
    if let Some(stop) = stop {
        stop.store(true, Ordering::Release);
    }
    json!({ "ok": true })
}

/// 游戏模式和退出使用：完整、轻量采样都停止，不能留下后台 CPU/GPU 查询。
pub fn sysinfo_stop_all() {
    let (full, light) = {
        let mut workers = workers()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (workers.full.take(), workers.light.take())
    };
    for stop in [full, light].into_iter().flatten() {
        stop.store(true, Ordering::Release);
    }
}
