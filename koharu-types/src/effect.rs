use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextShaderEffect {
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub faux_italic: bool,
    #[serde(default)]
    pub faux_bold: bool,
}

impl TextShaderEffect {
    pub const ITALIC_FLAG: u32 = 1 << 0;
    pub const BOLD_FLAG: u32 = 1 << 1;
    pub const FAUX_ITALIC_FLAG: u32 = 1 << 2;
    pub const FAUX_BOLD_FLAG: u32 = 1 << 3;

    pub fn flags(self) -> u32 {
        let mut flags = 0u32;
        if self.italic {
            flags |= Self::ITALIC_FLAG;
        }
        if self.bold {
            flags |= Self::BOLD_FLAG;
        }
        if self.faux_italic {
            flags |= Self::FAUX_ITALIC_FLAG;
        }
        if self.faux_bold {
            flags |= Self::FAUX_BOLD_FLAG;
        }
        flags
    }

    pub fn is_empty(self) -> bool {
        self.flags() == 0
    }

    pub fn none() -> Self {
        Self {
            italic: false,
            bold: false,
            faux_italic: false,
            faux_bold: false,
        }
    }
}

impl fmt::Display for TextShaderEffect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut parts: Vec<&str> = Vec::new();
        if self.italic {
            parts.push("italic");
        }
        if self.bold {
            parts.push("bold");
        }
        if self.faux_italic {
            parts.push("fauxItalic");
        }
        if self.faux_bold {
            parts.push("fauxBold");
        }

        if parts.is_empty() {
            f.write_str("none")
        } else {
            f.write_str(&parts.join(","))
        }
    }
}

impl FromStr for TextShaderEffect {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let normalized = s.trim().to_lowercase();
        if normalized.is_empty() || normalized == "none" || normalized == "normal" {
            return Ok(Self::none());
        }

        let mut effect = Self::none();
        for token in normalized
            .split(|c: char| c == ',' || c == '|' || c == '+' || c.is_whitespace())
            .filter(|token| !token.is_empty())
        {
            match token {
                "italic" => effect.italic = true,
                "bold" => effect.bold = true,
                "fauxitalic" | "faux_italic" => effect.faux_italic = true,
                "fauxbold" | "faux_bold" => effect.faux_bold = true,
                "normal" | "none" => {}
                _ => anyhow::bail!(
                    "Unknown shader effect: {token}. Valid: italic, bold, fauxItalic, fauxBold"
                ),
            }
        }

        Ok(effect)
    }
}

impl<'de> Deserialize<'de> for TextShaderEffect {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct FlagsRepr {
            italic: Option<bool>,
            bold: Option<bool>,
            faux_italic: Option<bool>,
            faux_bold: Option<bool>,
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Flags(FlagsRepr),
            Legacy(String),
        }

        match Repr::deserialize(deserializer)? {
            Repr::Flags(FlagsRepr {
                italic,
                bold,
                faux_italic,
                faux_bold,
            }) => Ok(Self {
                italic: italic.unwrap_or(false),
                bold: bold.unwrap_or(false),
                faux_italic: faux_italic.unwrap_or(false),
                faux_bold: faux_bold.unwrap_or(false),
            }),
            Repr::Legacy(value) => value.parse().map_err(serde::de::Error::custom),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TextShaderEffect;

    #[test]
    fn parse_combined_effects() {
        let effect: TextShaderEffect = "italic,bold".parse().expect("parse");
        assert!(effect.italic);
        assert!(effect.bold);
    }

    #[test]
    fn parse_legacy_effects_fail() {
        assert!("manga".parse::<TextShaderEffect>().is_err());
        assert!("motionblur".parse::<TextShaderEffect>().is_err());
    }

    #[test]
    fn default_has_no_effects() {
        let effect = TextShaderEffect::default();
        assert!(!effect.italic);
        assert!(!effect.bold);
        assert!(!effect.faux_italic);
        assert!(!effect.faux_bold);
    }

    #[test]
    fn parse_border_token_fails() {
        assert!("border".parse::<TextShaderEffect>().is_err());
    }

    #[test]
    fn parse_none_disables_all_effects() {
        let effect: TextShaderEffect = "none".parse().expect("parse");
        assert_eq!(effect.to_string(), "none");
    }
}
