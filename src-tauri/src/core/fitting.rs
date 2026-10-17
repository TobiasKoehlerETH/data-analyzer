//! Bounded nonlinear least squares for arbitrary numeric XY observations.
use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize)]
pub struct Parameter {
    pub name: String,
    pub start: f64,
    pub lower: Option<f64>,
    pub upper: Option<f64>,
    pub fixed: bool,
}

#[derive(Clone, Deserialize)]
pub struct FitRequest {
    pub points: Vec<[f64; 2]>,
    pub expression: String,
    pub parameters: Vec<Parameter>,
    pub normalize: bool,
    pub robust: bool,
}

#[derive(Serialize)]
pub struct FitResult {
    pub coefficients: Vec<f64>,
    pub standard_errors: Vec<Option<f64>>,
    pub curve: Vec<[f64; 2]>,
    pub lower: Vec<[f64; 2]>,
    pub upper: Vec<[f64; 2]>,
    pub residuals: Vec<[f64; 2]>,
    pub sse: f64,
    pub rmse: f64,
    pub r_squared: Option<f64>,
    pub adjusted_r_squared: Option<f64>,
    pub count: usize,
    pub iterations: usize,
    pub converged: bool,
    pub x_center: f64,
    pub x_scale: f64,
    pub warning: Option<String>,
}

pub fn fit(req: FitRequest) -> Result<FitResult, String> {
    let n = req.points.len();
    if req.parameters.is_empty() || req.parameters.len() > 8 {
        return Err("Use between 1 and 8 coefficients.".into());
    }
    if n < 3 || n > 1_000_000 || req.points.iter().flatten().any(|v| !v.is_finite()) {
        return Err("Fit between 3 and 1,000,000 finite XY pairs.".into());
    }
    for (i, p) in req.parameters.iter().enumerate() {
        if p.name.is_empty()
            || p.name == "x"
            || !p.name.chars().all(|c| c.is_ascii_alphabetic())
            || req.parameters[..i].iter().any(|q| q.name == p.name)
        {
            return Err("Coefficient names must be unique letters, excluding x.".into());
        }
        if !p.start.is_finite()
            || p.lower.is_some_and(|v| !v.is_finite())
            || p.upper.is_some_and(|v| !v.is_finite())
            || p.lower.unwrap_or(f64::NEG_INFINITY) >= p.upper.unwrap_or(f64::INFINITY)
            || p.lower.is_some_and(|v| p.start < v)
            || p.upper.is_some_and(|v| p.start > v)
        {
            return Err(format!(
                "Check the starting value and bounds for {}.",
                p.name
            ));
        }
    }
    let free: Vec<usize> = req
        .parameters
        .iter()
        .enumerate()
        .filter_map(|(i, p)| (!p.fixed).then_some(i))
        .collect();
    if n <= free.len() {
        return Err("Use more observations than free coefficients.".into());
    }
    let expression: meval::Expr = req
        .expression
        .parse()
        .map_err(|e| format!("Invalid equation: {e}"))?;
    let names: Vec<&str> = std::iter::once("x")
        .chain(req.parameters.iter().map(|p| p.name.as_str()))
        .collect();
    let function = expression
        .bindn(&names)
        .map_err(|e| format!("Check equation variables: {e}"))?;
    let x_min = req
        .points
        .iter()
        .map(|p| p[0])
        .fold(f64::INFINITY, f64::min);
    let x_max = req
        .points
        .iter()
        .map(|p| p[0])
        .fold(f64::NEG_INFINITY, f64::max);
    if x_min == x_max {
        return Err("X must contain at least two distinct values.".into());
    }
    let center = if req.normalize {
        x_min + (x_max - x_min) / 2.0
    } else {
        0.0
    };
    let scale = if req.normalize {
        (x_max - x_min) / 2.0
    } else {
        1.0
    };
    let evaluate = |x: f64, p: &[f64]| -> f64 {
        let mut values = Vec::with_capacity(p.len() + 1);
        values.push((x - center) / scale);
        values.extend_from_slice(p);
        function(&values)
    };
    let mut p: Vec<f64> = req.parameters.iter().map(|p| p.start).collect();
    let y_mean = req.points.iter().map(|p| p[1]).sum::<f64>() / n as f64;
    let sst = req
        .points
        .iter()
        .map(|p| (p[1] - y_mean).powi(2))
        .sum::<f64>();
    let delta = (0.1 * (sst / n as f64).sqrt()).max(1e-12);
    let residual = |p: &[f64]| -> DVector<f64> {
        DVector::from_iterator(n, req.points.iter().map(|v| v[1] - evaluate(v[0], p)))
    };
    let objective = |r: &DVector<f64>| -> f64 {
        r.iter()
            .map(|v| {
                if req.robust && v.abs() > delta {
                    2.0 * delta * v.abs() - delta * delta
                } else {
                    v * v
                }
            })
            .sum()
    };
    let jacobian = |p: &[f64]| -> DMatrix<f64> {
        DMatrix::from_fn(n, free.len(), |i, j| {
            let k = free[j];
            let h = 1e-6 * p[k].abs().max(1.0);
            let mut plus = p.to_vec();
            let mut minus = p.to_vec();
            plus[k] += h;
            minus[k] -= h;
            (evaluate(req.points[i][0], &plus) - evaluate(req.points[i][0], &minus)) / (2.0 * h)
        })
    };
    let mut r = residual(&p);
    if !objective(&r).is_finite() {
        return Err("The equation is not finite at the starting values. Adjust coefficients, X range, or normalization.".into());
    }
    let mut lambda = 1e-3;
    let mut converged = free.is_empty();
    let mut iterations = 0;
    for iteration in 0..250 {
        if converged {
            break;
        }
        iterations = iteration + 1;
        let mut j = jacobian(&p);
        if j.iter().any(|v| !v.is_finite()) {
            return Err(
                "The equation has an undefined derivative. Adjust the bounds or starting values."
                    .into(),
            );
        }
        let mut wr = r.clone();
        for i in 0..n {
            let weight = if req.robust && r[i].abs() > delta {
                (delta / r[i].abs()).sqrt()
            } else {
                1.0
            };
            wr[i] *= weight;
            for k in 0..free.len() {
                j[(i, k)] *= weight;
            }
        }
        let mut normal = j.transpose() * &j;
        let gradient = j.transpose() * wr;
        let projected_gradient = DVector::from_iterator(
            free.len(),
            free.iter().enumerate().map(|(k, &i)| {
                let at_lower = req.parameters[i]
                    .lower
                    .is_some_and(|b| p[i] <= b && gradient[k] < 0.0);
                let at_upper = req.parameters[i]
                    .upper
                    .is_some_and(|b| p[i] >= b && gradient[k] > 0.0);
                if at_lower || at_upper {
                    0.0
                } else {
                    gradient[k]
                }
            }),
        );
        if projected_gradient.amax() < 1e-9 {
            converged = true;
            break;
        }
        for k in 0..free.len() {
            normal[(k, k)] += lambda * normal[(k, k)].max(1e-12);
        }
        let Some(step) = normal.lu().solve(&gradient) else {
            lambda *= 10.0;
            continue;
        };
        let mut candidate = p.clone();
        for (k, &idx) in free.iter().enumerate() {
            candidate[idx] = (p[idx] + step[k]).clamp(
                req.parameters[idx].lower.unwrap_or(f64::NEG_INFINITY),
                req.parameters[idx].upper.unwrap_or(f64::INFINITY),
            );
        }
        let next = residual(&candidate);
        let old_cost = objective(&r);
        let new_cost = objective(&next);
        if new_cost.is_finite() && new_cost < old_cost {
            converged = old_cost - new_cost < 1e-10 * (1.0 + old_cost);
            p = candidate;
            r = next;
            lambda = (lambda / 3.0).max(1e-12);
        } else {
            lambda *= 10.0;
        }
        if lambda > 1e18 {
            break;
        }
    }
    let sse = r.dot(&r);
    let variance = sse / (n - free.len()) as f64;
    let j = jacobian(&p);
    let on_bound = free.iter().any(|&i| {
        let tol = 1e-6 * p[i].abs().max(1.0);
        req.parameters[i]
            .lower
            .is_some_and(|b| (p[i] - b).abs() < tol)
            || req.parameters[i]
                .upper
                .is_some_and(|b| (p[i] - b).abs() < tol)
    });
    let covariance = if !req.robust && !on_bound && converged && !free.is_empty() {
        let svd = j.svd(false, true);
        let largest = svd.singular_values.amax();
        if svd.singular_values.iter().all(|s| *s > largest * 1e-10) {
            svd.v_t.map(|vt| {
                vt.transpose()
                    * DMatrix::from_diagonal(&svd.singular_values.map(|s| variance / (s * s)))
                    * vt
            })
        } else {
            None
        }
    } else {
        None
    };
    let mut errors = vec![None; p.len()];
    if let Some(cov) = &covariance {
        for (k, &i) in free.iter().enumerate() {
            errors[i] = Some(cov[(k, k)].max(0.0).sqrt());
        }
    }
    let mut curve = Vec::new();
    let mut lower = Vec::new();
    let mut upper = Vec::new();
    for i in 0..301 {
        let x = x_min + (x_max - x_min) * i as f64 / 300.0;
        let y = evaluate(x, &p);
        if !y.is_finite() {
            continue;
        }
        curve.push([x, y]);
        if let Some(cov) = &covariance {
            let gradient = DVector::from_iterator(
                free.len(),
                free.iter().map(|&k| {
                    let h = 1e-6 * p[k].abs().max(1.0);
                    let mut plus = p.clone();
                    let mut minus = p.clone();
                    plus[k] += h;
                    minus[k] -= h;
                    (evaluate(x, &plus) - evaluate(x, &minus)) / (2.0 * h)
                }),
            );
            let margin = 1.96
                * (gradient.transpose() * cov * gradient)[(0, 0)]
                    .max(0.0)
                    .sqrt();
            if margin.is_finite() {
                lower.push([x, y - margin]);
                upper.push([x, y + margin]);
            }
        }
    }
    if curve.is_empty() || !sse.is_finite() {
        return Err("The fitted equation is not finite over this range.".into());
    }
    let r_squared = (sst > 0.0).then_some(1.0 - sse / sst);
    Ok(FitResult {
        coefficients: p,
        standard_errors: errors,
        curve,
        lower,
        upper,
        residuals: req
            .points
            .iter()
            .zip(r.iter())
            .map(|(v, r)| [v[0], *r])
            .collect(),
        sse,
        rmse: (sse / n as f64).sqrt(),
        r_squared,
        adjusted_r_squared: r_squared
            .map(|v| 1.0 - (1.0 - v) * (n - 1) as f64 / (n - free.len()) as f64),
        count: n,
        iterations,
        converged,
        x_center: center,
        x_scale: scale,
        warning: if !converged {
            Some("The optimizer did not converge. Try different starting values or a simpler equation.".into())
        } else if covariance.is_none() && !free.is_empty() {
            Some("Uncertainty is unavailable for robust fits, active bounds, or unidentifiable coefficients.".into())
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parameter(name: &str, start: f64) -> Parameter {
        Parameter {
            name: name.into(),
            start,
            lower: None,
            upper: None,
            fixed: false,
        }
    }
    #[test]
    fn recovers_linear_coefficients_and_residuals() {
        let result = fit(FitRequest {
            points: (0..100).map(|i| [i as f64, 3.0 * i as f64 + 7.0]).collect(),
            expression: "a*x+b".into(),
            parameters: vec![parameter("a", 1.0), parameter("b", 0.0)],
            normalize: false,
            robust: false,
        })
        .unwrap();
        assert!(result.converged);
        assert!((result.coefficients[0] - 3.0).abs() < 1e-6);
        assert!((result.coefficients[1] - 7.0).abs() < 1e-6);
        assert!(result.rmse < 1e-6);
    }
    #[test]
    fn recovers_exponential_decay_with_fixed_offset() {
        let mut offset = parameter("c", 2.0);
        offset.fixed = true;
        let result = fit(FitRequest {
            points: (0..100)
                .map(|i| {
                    let x = i as f64 / 10.0;
                    [x, 5.0 * (-x / 2.0).exp() + 2.0]
                })
                .collect(),
            expression: "a*exp(-x/b)+c".into(),
            parameters: vec![parameter("a", 4.0), parameter("b", 1.0), offset],
            normalize: false,
            robust: false,
        })
        .unwrap();
        assert!(result.converged);
        assert!((result.coefficients[0] - 5.0).abs() < 1e-5);
        assert!((result.coefficients[1] - 2.0).abs() < 1e-5);
        assert_eq!(result.coefficients[2], 2.0);
    }
    #[test]
    fn rejects_constant_x_and_unknown_variables() {
        let mut req = FitRequest {
            points: vec![[1.0, 2.0]; 10],
            expression: "a*x".into(),
            parameters: vec![parameter("a", 1.0)],
            normalize: false,
            robust: false,
        };
        assert!(fit(req.clone()).is_err());
        req.points[0][0] = 2.0;
        req.expression = "a*z".into();
        assert!(fit(req).is_err());
    }
    #[test]
    fn robust_fit_resists_an_outlier() {
        let points = (0..100)
            .map(|i| {
                [
                    i as f64,
                    2.0 * i as f64 + if i == 50 { 10000.0 } else { 0.0 },
                ]
            })
            .collect();
        let req = FitRequest {
            points,
            expression: "a*x+b".into(),
            parameters: vec![parameter("a", 1.0), parameter("b", 0.0)],
            normalize: false,
            robust: true,
        };
        let result = fit(req).unwrap();
        assert!((result.coefficients[0] - 2.0).abs() < 0.02);
        assert!(result.coefficients[1].abs() < 2.0);
        assert!(result.lower.is_empty());
    }
    #[test]
    fn normalization_handles_large_x_offsets() {
        let result = fit(FitRequest {
            points: (0..101)
                .map(|i| {
                    let x = 1e9 + i as f64;
                    let z = (x - (1e9 + 50.0)) / 50.0;
                    [x, 2.0 * z * z - 3.0 * z + 4.0]
                })
                .collect(),
            expression: "a*x^2+b*x+c".into(),
            parameters: vec![
                parameter("a", 1.0),
                parameter("b", 1.0),
                parameter("c", 0.0),
            ],
            normalize: true,
            robust: false,
        })
        .unwrap();
        assert!(result.converged);
        assert!(result.rmse < 1e-6);
        assert!((result.coefficients[0] - 2.0).abs() < 1e-6);
        assert_eq!(result.x_scale, 50.0);
    }
    #[test]
    fn respects_bounds_and_suppresses_invalid_uncertainty() {
        let mut a = parameter("a", 1.0);
        a.upper = Some(2.0);
        let result = fit(FitRequest {
            points: (0..20).map(|i| [i as f64, 3.0 * i as f64]).collect(),
            expression: "a*x".into(),
            parameters: vec![a],
            normalize: false,
            robust: false,
        })
        .unwrap();
        assert!(result.converged);
        assert!(result.coefficients[0] <= 2.0);
        assert!(result.standard_errors[0].is_none());
    }
    #[test]
    fn unidentifiable_coefficients_have_no_confidence_intervals() {
        let result = fit(FitRequest {
            points: (0..20).map(|i| [i as f64, 3.0 * i as f64]).collect(),
            expression: "(a+b)*x".into(),
            parameters: vec![parameter("a", 1.0), parameter("b", 1.0)],
            normalize: false,
            robust: false,
        })
        .unwrap();
        assert!(result.standard_errors.iter().all(Option::is_none));
        assert!(result.warning.is_some());
    }
}
