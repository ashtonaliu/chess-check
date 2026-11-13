const TAU_COUNT: usize = 80;

fn norm_cdf(x: f64) -> f64 {
    let x = x / std::f64::consts::SQRT_2;
    let a = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * a);
    let y = 1.0
        - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
            + 0.254829592)
            * t
            * (-a * a).exp());
    0.5 * (1.0 + if x == 0.0 { 0.0 } else { x.signum() } * y)
}

/// Returns posterior mean, standard deviation, interval endpoints and probability below zero.
pub fn shrink(groups: &[[f64; 2]], sigma2: f64, mu: f64) -> Vec<[f64; 5]> {
    let tau: [f64; TAU_COUNT] = std::array::from_fn(|i| 0.005 + (0.40 - 0.005) * i as f64 / 79.0);
    let noise: Vec<_> = groups.iter().map(|&[n, _]| sigma2 / n).collect();
    let logs = tau.map(|t| {
        let likelihood: f64 = groups
            .iter()
            .zip(&noise)
            .map(|(&[_, y], &noise)| {
                let variance = t * t + noise;
                variance.ln() + (y - mu).powi(2) / variance
            })
            .sum();
        -0.5 * likelihood - 0.5 * (t / 0.10).powi(2)
    });
    let max = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let weights = logs.map(|log| (log - max).exp());
    let total: f64 = weights.iter().sum();
    let weights = weights.map(|weight| weight / total);

    groups
        .iter()
        .zip(noise)
        .map(|(&[_, y], noise)| {
            let mut mean = 0.0;
            let mut second = 0.0;
            let mut below = 0.0;
            let components = std::array::from_fn::<_, TAU_COUNT, _>(|i| {
                let t2 = tau[i] * tau[i];
                let m = mu + t2 / (t2 + noise) * (y - mu);
                let variance = 1.0 / (1.0 / t2 + 1.0 / noise);
                let sd = variance.sqrt();
                mean += weights[i] * m;
                second += weights[i] * (variance + m * m);
                below += weights[i] * norm_cdf((0.0 - m) / sd);
                (m, sd)
            });
            let (mut lo, mut hi) = (f64::NAN, f64::NAN);
            for i in 0..=2000 {
                let x = -1.0 + 2.0 * i as f64 / 2000.0;
                let cdf: f64 = components
                    .iter()
                    .zip(weights)
                    .map(|(&(m, sd), w)| w * norm_cdf((x - m) / sd))
                    .sum();
                if lo.is_nan() && cdf >= 0.05 {
                    lo = x;
                }
                if cdf >= 0.95 {
                    hi = x;
                    break;
                }
            }
            [mean, (second - mean * mean).max(0.0).sqrt(), lo, hi, below]
        })
        .collect()
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::cell::RefCell;

    thread_local! {
        static GROUPS: RefCell<Vec<[f64; 2]>> = const { RefCell::new(Vec::new()) };
        static OUTPUT: RefCell<Vec<[f64; 5]>> = const { RefCell::new(Vec::new()) };
    }

    #[no_mangle]
    pub extern "C" fn reserve_groups(count: usize) -> *mut [f64; 2] {
        GROUPS.with_borrow_mut(|groups| {
            groups.resize(count, [0.0, 0.0]);
            groups.as_mut_ptr()
        })
    }

    #[no_mangle]
    pub extern "C" fn shrink_groups(sigma2: f64, mu: f64) -> *const [f64; 5] {
        let posteriors = GROUPS.with_borrow(|groups| super::shrink(groups, sigma2, mu));
        OUTPUT.with_borrow_mut(|output| {
            *output = posteriors;
            output.as_ptr()
        })
    }
}
