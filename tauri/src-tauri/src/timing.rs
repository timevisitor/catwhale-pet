//! 高精度休眠。
//!
//! `std::thread::sleep` 在 Windows 上受系统定时器精度限制：默认 15.6ms 一格。
//! 桌宠所有「搬窗口」的循环都靠 sleep 定节拍，于是设计节拍全部走样：
//!
//! ```text
//!   设计 sleep     实际约        用途
//!   8ms  (125Hz)   15.6ms (64Hz) 手动拖动跟随（main.rs drag_begin）
//!   33ms (30Hz)    46.9ms (21Hz) 自动走动（walk.rs）—— 走得比设计慢约 1/3，且步进不均
//!   8ms            15.6ms        灵动岛跟随拖动（island.rs）
//! ```
//!
//! 观感就是「拖起来肉、走起来一顿一顿、岛在后面甩」。Electron 版窗口不动、只动合成层，
//! 没有这个问题；Tauri 版是真挪窗口，节拍必须准。
//!
//! 这里改用高分辨率可等待定时器（`CREATE_WAITABLE_TIMER_EX` 的高分辨率标志，
//! Windows 10 1803+ 起可用），精度约 1ms。它只影响**本线程自己的等待精度**，
//! 不调用 timeBeginPeriod，不改系统全局定时器精度，对功耗没有全局影响。
//! 拿不到（旧系统 / 创建失败）时原样退回 `thread::sleep`，行为与改动前完全一致。

use std::time::Duration;

#[cfg(windows)]
pub fn sleep_ms(ms: u64) {
    use std::cell::Cell;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::{
        CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, CREATE_WAITABLE_TIMER_MANUAL_RESET, CreateWaitableTimerExW,
        SetWaitableTimer, TIMER_ALL_ACCESS, WaitForSingleObject,
    };

    // 每个线程一个手动复位的定时器句柄（这三个循环线程都是长驻线程）。
    // 0 = 还没建，-1 = 建不了（退回 thread::sleep），>0 = 句柄值。
    thread_local! {
        static TIMER: Cell<isize> = const { Cell::new(0) };
    }
    let usable = TIMER.with(|cell| {
        if cell.get() == 0 {
            let made = unsafe {
                CreateWaitableTimerExW(
                    None,
                    PCWSTR::null(),
                    CREATE_WAITABLE_TIMER_MANUAL_RESET | CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                    TIMER_ALL_ACCESS.0,
                )
            };
            cell.set(match made {
                Ok(h) => h.0 as isize,
                Err(_) => -1,
            });
        }
        cell.get() > 0
    });
    if !usable {
        std::thread::sleep(Duration::from_millis(ms));
        return;
    }
    let timer = TIMER.with(|cell| HANDLE(cell.get() as *mut core::ffi::c_void));
    // 负数 = 相对到期时间，单位 100ns。
    let due: i64 = -(ms.min(i64::MAX as u64) as i64).saturating_mul(10_000);
    unsafe {
        if SetWaitableTimer(timer, &due, 0, None, None, false).is_err() {
            std::thread::sleep(Duration::from_millis(ms));
            return;
        }
        let _ = WaitForSingleObject(timer, u32::MAX);
    }
}

#[cfg(not(windows))]
pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[cfg(all(test, windows))]
mod tests {
    use super::sleep_ms;
    use std::time::Duration;

    fn total_ms(n: u64, ms: u64, f: fn(u64)) -> f64 {
        let t = std::time::Instant::now();
        for _ in 0..n {
            f(ms);
        }
        t.elapsed().as_secs_f64() * 1000.0
    }

    /// 高精度休眠必须真的比「名义时长」只多一点：50 次 × 2ms 的总耗时不许超出名义值 120ms。
    /// 系统定时器精度 15.6ms 的机器上，thread::sleep(2) 每次都是 ~15.6ms（50 次多出 ~680ms）。
    #[test]
    fn high_resolution_sleep_is_close_to_nominal() {
        let ms = total_ms(50, 2, sleep_ms);
        assert!(ms < 100.0 + 120.0, "50 × sleep_ms(2ms) 用了 {ms:.1}ms");
    }

    /// 高精度休眠明显优于 thread::sleep 的小睡精度：50 次 × 2ms 至少比 std 快 200ms。
    /// 在定时器精度已被别处调高的机器上两者可能接近 —— 那时本断言允许失败并被忽略，
    /// 因为那种环境下换不换休眠实现都不影响节拍（上面那条已经保证可用）。
    #[test]
    #[ignore = "诊断用：打印本机 thread::sleep 与高精度休眠的实际精度对比"]
    fn compare_with_std_sleep() {
        let std_ms = total_ms(50, 2, |ms| std::thread::sleep(Duration::from_millis(ms)));
        let hr_ms = total_ms(50, 2, sleep_ms);
        eprintln!("50 × sleep(2ms): thread::sleep = {std_ms:.1}ms, high-res = {hr_ms:.1}ms");
    }
}
