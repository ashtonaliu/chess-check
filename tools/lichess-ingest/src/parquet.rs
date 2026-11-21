use std::{fs, path::Path, sync::Arc};

use anyhow::{Result, ensure};
use arrow_array::{ArrayRef, BooleanArray, Int32Array, Int64Array, RecordBatch, StringArray};
use parquet::{arrow::ArrowWriter, basic::Compression, file::properties::WriterProperties};

pub trait Column: Sized {
    fn array<'a>(values: impl Iterator<Item = Option<&'a Self>>) -> ArrayRef
    where
        Self: 'a;
}

impl Column for String {
    fn array<'a>(values: impl Iterator<Item = Option<&'a Self>>) -> ArrayRef {
        Arc::new(StringArray::from_iter(values))
    }
}

macro_rules! primitive {
    ($type:ty, $array:ty) => {
        impl Column for $type {
            fn array<'a>(values: impl Iterator<Item = Option<&'a Self>>) -> ArrayRef {
                Arc::new(values.map(|value| value.copied()).collect::<$array>())
            }
        }
    };
}

primitive!(bool, BooleanArray);
primitive!(i32, Int32Array);
primitive!(i64, Int64Array);

#[macro_export]
macro_rules! table {
    ($name:ident { $($field:ident: $type:ty),+ $(,)? }) => {
        #[derive(Default, Debug)]
        pub struct $name {
            $(pub $field: Option<$type>,)+
        }

        impl $name {
            pub fn batch(rows: &[Self]) -> anyhow::Result<arrow_array::RecordBatch> {
                Ok(arrow_array::RecordBatch::try_from_iter_with_nullable([
                    $((stringify!($field), <$type as $crate::parquet::Column>::array(
                        rows.iter().map(|row| row.$field.as_ref())
                    ), true),)+
                ])?)
            }
        }
    };
}

pub use crate::table;

pub fn encode(batch: RecordBatch) -> Result<Vec<u8>> {
    let props = WriterProperties::builder()
        .set_compression(Compression::ZSTD(Default::default()))
        .build();
    let mut buffer = Vec::new();
    let mut writer = ArrowWriter::try_new(&mut buffer, batch.schema(), Some(props))?;
    writer.write(&batch)?;
    writer.close()?;
    ensure!(buffer.len() < 256_000_000, "Parquet shard exceeds 256 MB");
    Ok(buffer)
}

pub fn publish(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("parquet.tmp");
    fs::write(&temp, bytes)?;
    fs::rename(temp, path)?;
    Ok(())
}
