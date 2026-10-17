//! Owned vectors and validated immutable mapped columns share slice access.
use anyhow::{ensure, Result};
use memmap2::Mmap;
use std::{fs::File, marker::PhantomData, ops::Deref, path::Path, sync::Arc};

// Only integer types with no invalid bit patterns are implemented here.
pub(crate) trait Element: Copy + std::fmt::Debug {}
impl Element for u8 {}
impl Element for u32 {}
impl Element for u64 {}

#[derive(Debug, Clone)]
pub(crate) enum Column<T: Element> {
    Memory(Vec<T>),
    Mapped {
        map: Arc<Mmap>,
        len: usize,
        marker: PhantomData<T>,
    },
}
impl<T: Element> Column<T> {
    pub fn map(path: &Path) -> Result<Self> {
        ensure!(
            cfg!(target_endian = "little"),
            "Disk columns require little-endian storage"
        );
        let file = File::open(path)?;
        let size = usize::try_from(file.metadata()?.len())?;
        ensure!(
            size % std::mem::size_of::<T>() == 0,
            "Invalid column length"
        );
        if size == 0 {
            return Ok(Self::Memory(Vec::new()));
        }
        // The caller owns this private immutable index. No mutable mappings exist.
        let map = unsafe { Mmap::map(&file)? };
        ensure!(
            (map.as_ptr() as usize) % std::mem::align_of::<T>() == 0,
            "Unaligned column"
        );
        Ok(Self::Mapped {
            map: Arc::new(map),
            len: size / std::mem::size_of::<T>(),
            marker: PhantomData,
        })
    }
}
impl<T: Element> From<Vec<T>> for Column<T> {
    fn from(value: Vec<T>) -> Self {
        Self::Memory(value)
    }
}
impl<T: Element> Deref for Column<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        match self {
            Self::Memory(values) => values,
            Self::Mapped { map, len, .. } => {
                // Alignment/length validated at construction; T has all bit patterns.
                unsafe { std::slice::from_raw_parts(map.as_ptr().cast::<T>(), *len) }
            }
        }
    }
}
