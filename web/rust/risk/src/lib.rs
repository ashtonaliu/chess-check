// Input rows contain the features followed by the binary outcome.
fn fit(input: &[f64], width: usize, penalty: f64, iterations: usize) -> Vec<f64> {
    let dimensions = width - 1;
    let count = (input.len() / width) as f64;
    let mut mean = vec![0.0; dimensions];
    let mut scale = vec![0.0; dimensions];
    for row in input.chunks_exact(width) {
        for j in 0..dimensions {
            mean[j] += row[j] / count;
        }
    }
    for row in input.chunks_exact(width) {
        for j in 0..dimensions {
            scale[j] += (row[j] - mean[j]).powi(2) / count;
        }
    }
    for value in &mut scale {
        *value = if *value == 0.0 { 1.0 } else { value.sqrt() };
    }
    let mut scaled = input.to_vec();
    for row in scaled.chunks_exact_mut(width) {
        for j in 0..dimensions {
            row[j] = (row[j] - mean[j]) / scale[j];
        }
    }

    let mut coefficients = vec![0.0; width];
    for _ in 0..iterations {
        let mut gradient = vec![0.0; width];
        let mut hessian = vec![vec![0.0; width]; width];
        for row in scaled.chunks_exact(width) {
            let mut logit = coefficients[dimensions];
            for j in 0..dimensions {
                logit += coefficients[j] * row[j];
            }
            let probability = if logit >= 0.0 {
                1.0 / (1.0 + (-logit).exp())
            } else {
                logit.exp() / (1.0 + logit.exp())
            };
            let residual = probability - row[dimensions];
            let weight = probability * (1.0 - probability);
            let feature = |j| if j == dimensions { 1.0 } else { row[j] };
            for j in 0..width {
                gradient[j] += residual * feature(j);
                for (k, entry) in hessian[j][..=j].iter_mut().enumerate() {
                    *entry += weight * feature(j) * feature(k);
                }
            }
        }
        for j in 0..dimensions {
            gradient[j] += coefficients[j] / penalty;
            hessian[j][j] += 1.0 / penalty;
        }
        let step = solve_spd(hessian, gradient);
        for (coefficient, delta) in coefficients.iter_mut().zip(&step) {
            *coefficient -= delta;
        }
        if step.iter().all(|delta| delta.abs() < 1e-10) {
            break;
        }
    }
    mean.extend(scale);
    mean.extend(coefficients);
    mean
}

// Factor the lower triangle in place, then solve the two triangular systems.
fn solve_spd(mut lower: Vec<Vec<f64>>, mut step: Vec<f64>) -> Vec<f64> {
    let n = step.len();
    for i in 0..n {
        for j in 0..=i {
            let mut value = lower[i][j];
            for (left, right) in lower[i][..j].iter().zip(&lower[j][..j]) {
                value -= left * right;
            }
            lower[i][j] = if i == j {
                value.max(1e-12).sqrt()
            } else {
                value / lower[j][j]
            };
        }
    }
    for i in 0..n {
        for k in 0..i {
            step[i] -= lower[i][k] * step[k];
        }
        step[i] /= lower[i][i];
    }
    for i in (0..n).rev() {
        for k in i + 1..n {
            step[i] -= lower[k][i] * step[k];
        }
        step[i] /= lower[i][i];
    }
    step
}

use std::cell::RefCell;
thread_local! {
    static INPUT: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn reserve_training(size: usize) -> *mut f64 {
    INPUT.with_borrow_mut(|input| {
        input.resize(size, 0.0);
        input.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn fit_training(width: usize, penalty: f64, iterations: usize) -> *const f64 {
    let result = INPUT.with_borrow(|input| fit(input, width, penalty, iterations));
    OUTPUT.with_borrow_mut(|output| {
        *output = result;
        output.as_ptr()
    })
}
