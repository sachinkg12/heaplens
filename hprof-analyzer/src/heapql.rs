//! HeapQL — A SQL-like query language for interrogating Java heap dumps.
//!
//! Supports `SELECT ... FROM <table> [WHERE ...] [ORDER BY ...] [LIMIT n]`
//! and special commands like `:path <id>`, `:refs <id>`, `:children <id>`, `:info <id>`.

use crate::{AnalysisState, ObjectReport};
use petgraph::graph::NodeIndex;
use serde::Serialize;
use std::time::Instant;
use thiserror::Error;

// ============================================================================
// Error type
// ============================================================================

#[derive(Error, Debug)]
pub enum HeapQlError {
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Unknown table: {0}")]
    UnknownTable(String),
    #[error("Unknown column '{0}' for table '{1}'")]
    UnknownColumn(String, String),
    #[error("Type mismatch: expected {0}, got {1}")]
    TypeMismatch(String, String),
    #[error("Execution error: {0}")]
    Execution(String),
}

// ============================================================================
// Tokens
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Select,
    From,
    Where,
    Order,
    By,
    Asc,
    Desc,
    Limit,
    And,
    Or,
    Like,
    Count,
    Sum,
    Avg,
    Min,
    Max,
    Group,
    Ident(String),
    StringLit(String),
    IntLit(u64),
    FloatLit(f64),
    Eq,
    Neq,
    Gt,
    Lt,
    Gte,
    Lte,
    Star,
    Comma,
    LParen,
    RParen,
    Join,
    Inner,
    Left,
    On,
    As,
    In,
    Colon,
    Eof,
}

// ============================================================================
// AST types
// ============================================================================

#[derive(Debug, Clone)]
pub enum Statement {
    Select(SelectStatement),
    Special(SpecialCommand),
}

#[derive(Debug, Clone, PartialEq)]
pub enum AggFunc {
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

impl std::fmt::Display for AggFunc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AggFunc::Count => write!(f, "count"),
            AggFunc::Sum => write!(f, "sum"),
            AggFunc::Avg => write!(f, "avg"),
            AggFunc::Min => write!(f, "min"),
            AggFunc::Max => write!(f, "max"),
        }
    }
}

#[derive(Debug, Clone)]
pub enum SelectColumn {
    Named(String),
    Star,
    Aggregate(AggFunc, String), // func, column (or "*" for COUNT(*))
}

#[derive(Debug, Clone)]
pub struct SelectStatement {
    pub columns: Vec<String>,
    pub select_columns: Vec<SelectColumn>,
    pub table: TableName,
    pub table_alias: Option<String>,
    pub join: Option<JoinClause>,
    pub where_clause: Option<WhereClause>,
    pub order_by: Option<OrderBy>,
    pub limit: Option<u64>,
    pub group_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TableName {
    Instances,
    ClassHistogram,
    DominatorTree,
    LeakSuspects,
}

impl std::fmt::Display for TableName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TableName::Instances => write!(f, "instances"),
            TableName::ClassHistogram => write!(f, "class_histogram"),
            TableName::DominatorTree => write!(f, "dominator_tree"),
            TableName::LeakSuspects => write!(f, "leak_suspects"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TableRef {
    pub table: TableName,
    pub alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum JoinKind {
    Inner,
    Left,
}

#[derive(Debug, Clone)]
pub struct JoinClause {
    pub right: TableRef,
    pub kind: JoinKind,
    pub on_left_col: String,
    pub on_right_col: String,
}

#[derive(Debug, Clone)]
pub enum WhereClause {
    Condition(Condition),
    And(Box<WhereClause>, Box<WhereClause>),
    Or(Box<WhereClause>, Box<WhereClause>),
}

#[derive(Debug, Clone)]
pub struct Condition {
    pub column: String,
    pub op: CompOp,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CompOp {
    Eq,
    Neq,
    Gt,
    Lt,
    Gte,
    Lte,
    Like,
    In,
}

#[derive(Debug, Clone)]
pub enum Value {
    String(String),
    Int(u64),
    Float(f64),
    Subquery(Box<SelectStatement>),
    ResolvedSet(Vec<serde_json::Value>),
}

#[derive(Debug, Clone)]
pub struct OrderBy {
    pub column: String,
    pub descending: bool,
}

#[derive(Debug, Clone)]
pub enum SpecialCommand {
    Path(u64),
    Refs(u64),
    Children(u64),
    Info(u64),
}

// ============================================================================
// Query result
// ============================================================================

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_scanned: u64,
    pub total_matched: u64,
    pub execution_time_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_pages: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_rows: Option<u64>,
}

// ============================================================================
// Tokenizer
// ============================================================================

struct Tokenizer {
    chars: Vec<char>,
    pos: usize,
}

impl Tokenizer {
    fn new(input: &str) -> Self {
        Self {
            chars: input.chars().collect(),
            pos: 0,
        }
    }

    fn tokenize(&mut self) -> Result<Vec<Token>, HeapQlError> {
        let mut tokens = Vec::new();
        loop {
            self.skip_whitespace();
            if self.pos >= self.chars.len() {
                tokens.push(Token::Eof);
                break;
            }
            let ch = self.chars[self.pos];
            match ch {
                '*' => { tokens.push(Token::Star); self.pos += 1; }
                ',' => { tokens.push(Token::Comma); self.pos += 1; }
                '(' => { tokens.push(Token::LParen); self.pos += 1; }
                ')' => { tokens.push(Token::RParen); self.pos += 1; }
                ':' => { tokens.push(Token::Colon); self.pos += 1; }
                '=' => { tokens.push(Token::Eq); self.pos += 1; }
                '!' => {
                    self.pos += 1;
                    if self.pos < self.chars.len() && self.chars[self.pos] == '=' {
                        tokens.push(Token::Neq); self.pos += 1;
                    } else {
                        return Err(HeapQlError::Parse("Expected '=' after '!'".into()));
                    }
                }
                '>' => {
                    self.pos += 1;
                    if self.pos < self.chars.len() && self.chars[self.pos] == '=' {
                        tokens.push(Token::Gte); self.pos += 1;
                    } else {
                        tokens.push(Token::Gt);
                    }
                }
                '<' => {
                    self.pos += 1;
                    if self.pos < self.chars.len() && self.chars[self.pos] == '=' {
                        tokens.push(Token::Lte); self.pos += 1;
                    } else {
                        tokens.push(Token::Lt);
                    }
                }
                '\'' => {
                    tokens.push(self.read_string_lit()?);
                }
                c if c.is_ascii_digit() => {
                    tokens.push(self.read_number()?);
                }
                c if c.is_ascii_alphabetic() || c == '_' => {
                    tokens.push(self.read_ident_or_keyword());
                }
                _ => {
                    return Err(HeapQlError::Parse(format!("Unexpected character: '{}'", ch)));
                }
            }
        }
        Ok(tokens)
    }

    fn skip_whitespace(&mut self) {
        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn read_string_lit(&mut self) -> Result<Token, HeapQlError> {
        self.pos += 1; // skip opening quote
        let mut s = String::new();
        while self.pos < self.chars.len() && self.chars[self.pos] != '\'' {
            s.push(self.chars[self.pos]);
            self.pos += 1;
        }
        if self.pos >= self.chars.len() {
            return Err(HeapQlError::Parse("Unterminated string literal".into()));
        }
        self.pos += 1; // skip closing quote
        Ok(Token::StringLit(s))
    }

    fn read_number(&mut self) -> Result<Token, HeapQlError> {
        let start = self.pos;
        let mut has_dot = false;
        while self.pos < self.chars.len() {
            let c = self.chars[self.pos];
            if c.is_ascii_digit() {
                self.pos += 1;
            } else if c == '.' && !has_dot {
                has_dot = true;
                self.pos += 1;
            } else {
                break;
            }
        }
        let num_str: String = self.chars[start..self.pos].iter().collect();
        let base: f64 = num_str.parse()
            .map_err(|_| HeapQlError::Parse(format!("Invalid number: {}", num_str)))?;

        // Check for size suffix (B, KB, MB, GB) — optional whitespace before suffix
        let saved_pos = self.pos;
        let mut suffix_pos = self.pos;
        while suffix_pos < self.chars.len() && self.chars[suffix_pos] == ' ' {
            suffix_pos += 1;
        }
        let suffix_start = suffix_pos;
        while suffix_pos < self.chars.len() && self.chars[suffix_pos].is_ascii_alphabetic() {
            suffix_pos += 1;
        }
        let suffix: String = self.chars[suffix_start..suffix_pos].iter().collect();
        let multiplier: Option<u64> = match suffix.to_uppercase().as_str() {
            "B"  => Some(1),
            "KB" => Some(1 << 10),
            "MB" => Some(1 << 20),
            "GB" => Some(1 << 30),
            "TB" => Some(1 << 40),
            "PB" => Some(1 << 50),
            "EB" => Some(1 << 60),
            _ => None,
        };

        if let Some(mult) = multiplier {
            self.pos = suffix_pos;
            let val = (base * mult as f64) as u64;
            Ok(Token::IntLit(val))
        } else {
            self.pos = saved_pos;
            if has_dot {
                Ok(Token::FloatLit(base))
            } else {
                Ok(Token::IntLit(base as u64))
            }
        }
    }

    fn read_ident_or_keyword(&mut self) -> Token {
        let start = self.pos;
        while self.pos < self.chars.len() {
            let c = self.chars[self.pos];
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '*' {
                self.pos += 1;
            } else {
                break;
            }
        }
        let word: String = self.chars[start..self.pos].iter().collect();
        let upper = word.to_uppercase();
        match upper.as_str() {
            "SELECT" => Token::Select,
            "FROM" => Token::From,
            "WHERE" => Token::Where,
            "ORDER" => Token::Order,
            "BY" => Token::By,
            "ASC" => Token::Asc,
            "DESC" => Token::Desc,
            "LIMIT" => Token::Limit,
            "AND" => Token::And,
            "OR" => Token::Or,
            "LIKE" => Token::Like,
            "COUNT" => Token::Count,
            "SUM" => Token::Sum,
            "AVG" => Token::Avg,
            "MIN" => Token::Min,
            "MAX" => Token::Max,
            "GROUP" => Token::Group,
            "JOIN" => Token::Join,
            "INNER" => Token::Inner,
            "LEFT" => Token::Left,
            "ON" => Token::On,
            "AS" => Token::As,
            "IN" => Token::In,
            _ => Token::Ident(word),
        }
    }
}

// ============================================================================
// Parser
// ============================================================================

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token::Eof)
    }

    fn advance(&mut self) -> Token {
        let tok = self.tokens.get(self.pos).cloned().unwrap_or(Token::Eof);
        self.pos += 1;
        tok
    }

    fn expect(&mut self, expected: &Token) -> Result<Token, HeapQlError> {
        let tok = self.advance();
        if std::mem::discriminant(&tok) == std::mem::discriminant(expected) {
            Ok(tok)
        } else {
            Err(HeapQlError::Parse(format!("Expected {:?}, got {:?}", expected, tok)))
        }
    }

    fn parse(&mut self) -> Result<Statement, HeapQlError> {
        match self.peek() {
            Token::Colon => self.parse_special(),
            Token::Select => self.parse_select(),
            other => Err(HeapQlError::Parse(format!(
                "Expected SELECT or ':' command, got {:?}", other
            ))),
        }
    }

    fn parse_special(&mut self) -> Result<Statement, HeapQlError> {
        self.advance(); // consume ':'
        let cmd_tok = self.advance();
        let cmd_name = match cmd_tok {
            Token::Ident(s) => s.to_lowercase(),
            _ => return Err(HeapQlError::Parse("Expected command name after ':'".into())),
        };
        let id_tok = self.advance();
        let id = match id_tok {
            Token::IntLit(n) => n,
            _ => return Err(HeapQlError::Parse("Expected integer object_id".into())),
        };
        let cmd = match cmd_name.as_str() {
            "path" => SpecialCommand::Path(id),
            "refs" => SpecialCommand::Refs(id),
            "children" => SpecialCommand::Children(id),
            "info" => SpecialCommand::Info(id),
            _ => return Err(HeapQlError::Parse(format!("Unknown command: {}", cmd_name))),
        };
        Ok(Statement::Special(cmd))
    }

    fn parse_select(&mut self) -> Result<Statement, HeapQlError> {
        self.advance(); // consume SELECT

        // Parse select list
        let (columns, select_columns) = self.parse_select_list()?;

        // FROM
        self.expect(&Token::From)?;
        let table = self.parse_table_name()?;

        // Optional alias (AS alias or bare identifier)
        let table_alias = self.parse_optional_alias()?;

        // Optional JOIN
        let join = self.parse_optional_join()?;

        // Optional WHERE
        let where_clause = if matches!(self.peek(), Token::Where) {
            self.advance();
            Some(self.parse_where()?)
        } else {
            None
        };

        // Optional GROUP BY
        let group_by = if matches!(self.peek(), Token::Group) {
            self.advance(); // consume GROUP
            self.expect(&Token::By)?;
            Some(self.parse_column_name()?)
        } else {
            None
        };

        // Optional ORDER BY
        let order_by = if matches!(self.peek(), Token::Order) {
            self.advance();
            self.expect(&Token::By)?;
            Some(self.parse_order_by()?)
        } else {
            None
        };

        // Optional LIMIT
        let limit = if matches!(self.peek(), Token::Limit) {
            self.advance();
            match self.advance() {
                Token::IntLit(n) => Some(n),
                _ => return Err(HeapQlError::Parse("Expected integer after LIMIT".into())),
            }
        } else {
            None
        };

        Ok(Statement::Select(SelectStatement {
            columns,
            select_columns,
            table,
            table_alias,
            join,
            where_clause,
            order_by,
            limit,
            group_by,
        }))
    }

    fn parse_select_list(&mut self) -> Result<(Vec<String>, Vec<SelectColumn>), HeapQlError> {
        if matches!(self.peek(), Token::Star) {
            self.advance();
            return Ok((vec!["*".into()], vec![SelectColumn::Star]));
        }
        let (name, sc) = self.parse_select_item()?;
        let mut names = vec![name];
        let mut scs = vec![sc];
        while matches!(self.peek(), Token::Comma) {
            self.advance();
            let (name, sc) = self.parse_select_item()?;
            names.push(name);
            scs.push(sc);
        }
        Ok((names, scs))
    }

    fn parse_select_item(&mut self) -> Result<(String, SelectColumn), HeapQlError> {
        // Check for aggregate function
        let agg_func = match self.peek() {
            Token::Count => Some(AggFunc::Count),
            Token::Sum => Some(AggFunc::Sum),
            Token::Avg => Some(AggFunc::Avg),
            Token::Min => Some(AggFunc::Min),
            Token::Max => Some(AggFunc::Max),
            _ => None,
        };

        if let Some(func) = agg_func {
            self.advance(); // consume the aggregate keyword
            self.expect(&Token::LParen)?;
            let col_name = if matches!(self.peek(), Token::Star) {
                self.advance();
                "*".to_string()
            } else {
                self.parse_column_name()?
            };
            self.expect(&Token::RParen)?;
            let display = format!("{}({})", func, col_name);
            Ok((display, SelectColumn::Aggregate(func, col_name)))
        } else {
            let name = self.parse_column_name()?;
            Ok((name.clone(), SelectColumn::Named(name)))
        }
    }

    fn parse_column_name(&mut self) -> Result<String, HeapQlError> {
        match self.advance() {
            Token::Ident(s) => Ok(s),
            other => Err(HeapQlError::Parse(format!("Expected column name, got {:?}", other))),
        }
    }

    fn parse_table_name(&mut self) -> Result<TableName, HeapQlError> {
        match self.advance() {
            Token::Ident(s) => match s.to_lowercase().as_str() {
                "instances" => Ok(TableName::Instances),
                "class_histogram" => Ok(TableName::ClassHistogram),
                "dominator_tree" => Ok(TableName::DominatorTree),
                "leak_suspects" => Ok(TableName::LeakSuspects),
                _ => Err(HeapQlError::UnknownTable(s)),
            },
            other => Err(HeapQlError::Parse(format!("Expected table name, got {:?}", other))),
        }
    }

    /// Parse optional alias: `AS alias` or bare identifier (if short and not a keyword).
    fn parse_optional_alias(&mut self) -> Result<Option<String>, HeapQlError> {
        if matches!(self.peek(), Token::As) {
            self.advance(); // consume AS
            let name = self.parse_column_name()?;
            return Ok(Some(name));
        }
        // Bare alias: short identifier that isn't a keyword
        if let Token::Ident(ref s) = self.peek().clone() {
            if s.len() <= 3 && !s.contains('.') {
                let alias = s.clone();
                self.advance();
                return Ok(Some(alias));
            }
        }
        Ok(None)
    }

    /// Parse optional JOIN clause: `[INNER|LEFT] JOIN table [AS alias] ON col = col`
    fn parse_optional_join(&mut self) -> Result<Option<JoinClause>, HeapQlError> {
        let kind = match self.peek() {
            Token::Join => {
                self.advance();
                JoinKind::Inner
            }
            Token::Inner => {
                self.advance();
                self.expect(&Token::Join)?;
                JoinKind::Inner
            }
            Token::Left => {
                self.advance();
                self.expect(&Token::Join)?;
                JoinKind::Left
            }
            _ => return Ok(None),
        };

        let table = self.parse_table_name()?;
        let alias = self.parse_optional_alias()?;

        self.expect(&Token::On)?;
        let left_col = self.parse_column_name()?;
        self.expect(&Token::Eq)?;
        let right_col = self.parse_column_name()?;

        Ok(Some(JoinClause {
            right: TableRef { table, alias },
            kind,
            on_left_col: left_col,
            on_right_col: right_col,
        }))
    }

    fn parse_where(&mut self) -> Result<WhereClause, HeapQlError> {
        let left = self.parse_condition()?;
        self.parse_where_rest(left)
    }

    fn parse_where_rest(&mut self, left: WhereClause) -> Result<WhereClause, HeapQlError> {
        match self.peek() {
            Token::And => {
                self.advance();
                let right = self.parse_condition()?;
                let combined = WhereClause::And(Box::new(left), Box::new(right));
                self.parse_where_rest(combined)
            }
            Token::Or => {
                self.advance();
                let right = self.parse_condition()?;
                let combined = WhereClause::Or(Box::new(left), Box::new(right));
                self.parse_where_rest(combined)
            }
            _ => Ok(left),
        }
    }

    fn parse_condition(&mut self) -> Result<WhereClause, HeapQlError> {
        let column = self.parse_column_name()?;

        // IN (SELECT ...) or IN (values)
        if matches!(self.peek(), Token::In) {
            self.advance(); // consume IN
            self.expect(&Token::LParen)?;
            if matches!(self.peek(), Token::Select) {
                let inner = self.parse_select_inner()?;
                self.expect(&Token::RParen)?;
                return Ok(WhereClause::Condition(Condition {
                    column,
                    op: CompOp::In,
                    value: Value::Subquery(Box::new(inner)),
                }));
            }
            return Err(HeapQlError::Parse("Expected SELECT after IN (".into()));
        }

        let (op, value) = if matches!(self.peek(), Token::Like) {
            self.advance();
            match self.advance() {
                Token::StringLit(s) => (CompOp::Like, Value::String(s)),
                _ => return Err(HeapQlError::Parse("Expected string after LIKE".into())),
            }
        } else {
            let op = match self.advance() {
                Token::Eq => CompOp::Eq,
                Token::Neq => CompOp::Neq,
                Token::Gt => CompOp::Gt,
                Token::Lt => CompOp::Lt,
                Token::Gte => CompOp::Gte,
                Token::Lte => CompOp::Lte,
                other => return Err(HeapQlError::Parse(format!("Expected operator, got {:?}", other))),
            };
            // Check for (SELECT ...) as scalar subquery
            let value = if matches!(self.peek(), Token::LParen) {
                let saved = self.pos;
                self.advance(); // consume (
                if matches!(self.peek(), Token::Select) {
                    let inner = self.parse_select_inner()?;
                    self.expect(&Token::RParen)?;
                    Value::Subquery(Box::new(inner))
                } else {
                    self.pos = saved;
                    self.parse_literal_value()?
                }
            } else {
                self.parse_literal_value()?
            };
            (op, value)
        };
        Ok(WhereClause::Condition(Condition { column, op, value }))
    }

    fn parse_literal_value(&mut self) -> Result<Value, HeapQlError> {
        match self.advance() {
            Token::StringLit(s) => Ok(Value::String(s)),
            Token::IntLit(n) => Ok(Value::Int(n)),
            Token::FloatLit(f) => Ok(Value::Float(f)),
            other => Err(HeapQlError::Parse(format!("Expected value, got {:?}", other))),
        }
    }

    /// Parse a SELECT statement without consuming the leading position (reuses parse_select logic).
    fn parse_select_inner(&mut self) -> Result<SelectStatement, HeapQlError> {
        let stmt = self.parse_select()?;
        match stmt {
            Statement::Select(s) => Ok(s),
            _ => Err(HeapQlError::Parse("Expected SELECT statement in subquery".into())),
        }
    }

    fn parse_order_by(&mut self) -> Result<OrderBy, HeapQlError> {
        // ORDER BY can reference aggregate expressions like count(*), sum(col)
        let column = match self.peek() {
            Token::Count | Token::Sum | Token::Avg | Token::Min | Token::Max => {
                let func_name = match self.advance() {
                    Token::Count => "count",
                    Token::Sum => "sum",
                    Token::Avg => "avg",
                    Token::Min => "min",
                    Token::Max => "max",
                    _ => unreachable!(),
                };
                self.expect(&Token::LParen)?;
                let col = if matches!(self.peek(), Token::Star) {
                    self.advance();
                    "*".to_string()
                } else {
                    self.parse_column_name()?
                };
                self.expect(&Token::RParen)?;
                format!("{}({})", func_name, col)
            }
            _ => self.parse_column_name()?,
        };
        let descending = match self.peek() {
            Token::Desc => { self.advance(); true }
            Token::Asc => { self.advance(); false }
            _ => false,
        };
        Ok(OrderBy { column, descending })
    }
}

// ============================================================================
// Column definitions per table
// ============================================================================

fn table_columns(table: &TableName) -> Vec<&'static str> {
    match table {
        TableName::Instances => vec!["object_id", "node_type", "class_name", "shallow_size", "retained_size"],
        TableName::ClassHistogram => vec!["class_name", "instance_count", "shallow_size", "retained_size"],
        TableName::DominatorTree => vec!["object_id", "node_type", "class_name", "shallow_size", "retained_size"],
        TableName::LeakSuspects => vec!["class_name", "object_id", "retained_size", "retained_percentage", "description"],
    }
}

fn validate_columns(columns: &[String], table: &TableName) -> Result<Vec<String>, HeapQlError> {
    let valid = table_columns(table);
    if columns.len() == 1 && columns[0] == "*" {
        return Ok(valid.iter().map(|s| s.to_string()).collect());
    }
    for col in columns {
        if !valid.contains(&col.as_str()) {
            return Err(HeapQlError::UnknownColumn(col.clone(), table.to_string()));
        }
    }
    Ok(columns.to_vec())
}

// ============================================================================
// Row value helpers
// ============================================================================

type Row = Vec<serde_json::Value>;

fn get_col_value(row: &Row, columns: &[String], col_name: &str) -> Option<serde_json::Value> {
    columns.iter().position(|c| c == col_name).map(|i| row[i].clone())
}

fn compare_json_values(a: &serde_json::Value, b: &serde_json::Value) -> std::cmp::Ordering {
    match (a, b) {
        (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
            let af = a.as_f64().unwrap_or(0.0);
            let bf = b.as_f64().unwrap_or(0.0);
            af.partial_cmp(&bf).unwrap_or(std::cmp::Ordering::Equal)
        }
        (serde_json::Value::String(a), serde_json::Value::String(b)) => a.cmp(b),
        _ => std::cmp::Ordering::Equal,
    }
}

// ============================================================================
// WHERE evaluation
// ============================================================================

fn eval_where(row: &Row, columns: &[String], clause: &WhereClause) -> bool {
    match clause {
        WhereClause::Condition(cond) => eval_condition(row, columns, cond),
        WhereClause::And(a, b) => eval_where(row, columns, a) && eval_where(row, columns, b),
        WhereClause::Or(a, b) => eval_where(row, columns, a) || eval_where(row, columns, b),
    }
}

fn eval_condition(row: &Row, columns: &[String], cond: &Condition) -> bool {
    let val = match get_col_value(row, columns, &cond.column) {
        Some(v) => v,
        None => return false,
    };

    match &cond.op {
        CompOp::Like => {
            let row_str = match &val {
                serde_json::Value::String(s) => s.as_str(),
                _ => return false,
            };
            let pattern = match &cond.value {
                Value::String(s) => s.as_str(),
                _ => return false,
            };
            like_match(row_str, pattern)
        }
        CompOp::In => {
            // IN with resolved set
            if let Value::ResolvedSet(ref set) = cond.value {
                set.iter().any(|sv| {
                    match (&val, sv) {
                        (serde_json::Value::String(a), serde_json::Value::String(b)) => a == b,
                        (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
                            a.as_f64().unwrap_or(0.0) == b.as_f64().unwrap_or(0.0)
                        }
                        _ => val == *sv,
                    }
                })
            } else {
                false
            }
        }
        op => {
            let ordering = match &cond.value {
                Value::Int(n) => {
                    let row_val = val.as_u64().or_else(|| val.as_f64().map(|f| f as u64));
                    match row_val {
                        Some(rv) => rv.cmp(n),
                        None => return false,
                    }
                }
                Value::Float(f) => {
                    let row_val = val.as_f64();
                    match row_val {
                        Some(rv) => rv.partial_cmp(f).unwrap_or(std::cmp::Ordering::Equal),
                        None => return false,
                    }
                }
                Value::String(s) => {
                    let row_str = match &val {
                        serde_json::Value::String(rs) => rs.as_str(),
                        _ => return false,
                    };
                    row_str.cmp(s.as_str())
                }
                _ => return false,
            };
            match op {
                CompOp::Eq => ordering == std::cmp::Ordering::Equal,
                CompOp::Neq => ordering != std::cmp::Ordering::Equal,
                CompOp::Gt => ordering == std::cmp::Ordering::Greater,
                CompOp::Lt => ordering == std::cmp::Ordering::Less,
                CompOp::Gte => ordering != std::cmp::Ordering::Less,
                CompOp::Lte => ordering != std::cmp::Ordering::Greater,
                CompOp::Like | CompOp::In => unreachable!(),
            }
        }
    }
}

fn like_match(value: &str, pattern: &str) -> bool {
    let lower_value = value.to_lowercase();
    let lower_pattern = pattern.to_lowercase();
    let starts = lower_pattern.starts_with('%');
    let ends = lower_pattern.ends_with('%');
    let trimmed = lower_pattern.trim_matches('%');

    if trimmed.is_empty() {
        return true;
    }

    match (starts, ends) {
        (true, true) => lower_value.contains(trimmed),
        (true, false) => lower_value.ends_with(trimmed),
        (false, true) => lower_value.starts_with(trimmed),
        (false, false) => lower_value == trimmed,
    }
}

// ============================================================================
// Query executor
// ============================================================================

impl AnalysisState {
    /// Executes a HeapQL query string against this analysis state.
    pub fn execute_query(&self, query_str: &str) -> Result<QueryResult, HeapQlError> {
        let start = Instant::now();

        let mut tokenizer = Tokenizer::new(query_str);
        let tokens = tokenizer.tokenize()?;

        let mut parser = Parser::new(tokens);
        let statement = parser.parse()?;

        let result = match statement {
            Statement::Select(select) => self.execute_select(select, start)?,
            Statement::Special(cmd) => self.execute_special(cmd, start)?,
        };

        Ok(result)
    }

    /// Scan all rows from a table, returning (columns, rows).
    fn scan_table(&self, table: &TableName) -> (Vec<String>, Vec<Row>) {
        let cols: Vec<String> = table_columns(table).iter().map(|s| s.to_string()).collect();
        let mut rows = Vec::new();
        match table {
            TableName::Instances => {
                for (i, (obj_id, node_type, class_name)) in self.node_data_map.iter().enumerate() {
                    if *node_type == "SuperRoot" || *node_type == "Root" || *node_type == "Class" {
                        continue;
                    }
                    let retained = self.retained_sizes.get(i).copied().unwrap_or(0);
                    if retained == 0 { continue; }
                    let shallow = self.shallow_sizes.get(i).copied().unwrap_or(0);
                    rows.push(vec![
                        serde_json::json!(*obj_id),
                        serde_json::json!(*node_type),
                        serde_json::json!(class_name.as_ref()),
                        serde_json::json!(shallow),
                        serde_json::json!(retained),
                    ]);
                }
            }
            TableName::ClassHistogram => {
                for entry in &self.class_histogram {
                    rows.push(vec![
                        serde_json::json!(&entry.class_name),
                        serde_json::json!(entry.instance_count),
                        serde_json::json!(entry.shallow_size),
                        serde_json::json!(entry.retained_size),
                    ]);
                }
            }
            TableName::DominatorTree => {
                // Full scan of dominator tree children from super_root
                fn collect_all(state: &crate::AnalysisState, idx: petgraph::graph::NodeIndex, rows: &mut Vec<Row>) {
                    if let Some(children) = state.children_map.get(&idx) {
                        for &child in children {
                            let i = child.index();
                            if i >= state.node_data_map.len() { continue; }
                            let (obj_id, node_type, ref class_name) = state.node_data_map[i];
                            if node_type == "Class" { continue; }
                            let retained = state.retained_sizes.get(i).copied().unwrap_or(0);
                            if retained == 0 { continue; }
                            let shallow = state.shallow_sizes.get(i).copied().unwrap_or(0);
                            rows.push(vec![
                                serde_json::json!(obj_id),
                                serde_json::json!(node_type),
                                serde_json::json!(class_name.as_ref()),
                                serde_json::json!(shallow),
                                serde_json::json!(retained),
                            ]);
                            collect_all(state, child, rows);
                        }
                    }
                }
                collect_all(self, self.super_root, &mut rows);
            }
            TableName::LeakSuspects => {
                for suspect in &self.leak_suspects {
                    rows.push(vec![
                        serde_json::json!(&suspect.class_name),
                        serde_json::json!(suspect.object_id),
                        serde_json::json!(suspect.retained_size),
                        serde_json::json!(suspect.retained_percentage),
                        serde_json::json!(&suspect.description),
                    ]);
                }
            }
        }
        (cols, rows)
    }

    /// Execute a JOIN query using hash join.
    fn execute_join(&self, stmt: SelectStatement, start: Instant) -> Result<QueryResult, HeapQlError> {
        let join = stmt.join.as_ref().unwrap();
        let left_table_str = stmt.table.to_string();
        let right_table_str = join.right.table.to_string();
        let left_alias = stmt.table_alias.as_deref().unwrap_or(&left_table_str);
        let right_alias = join.right.alias.as_deref().unwrap_or(&right_table_str);

        let (left_cols, left_rows) = self.scan_table(&stmt.table);
        let (right_cols, right_rows) = self.scan_table(&join.right.table);

        // Resolve join column names (strip alias prefix if present)
        let on_left = strip_alias_prefix(&join.on_left_col, left_alias, right_alias);
        let on_right = strip_alias_prefix(&join.on_right_col, left_alias, right_alias);

        // Find column indices for join keys
        let left_key_idx = left_cols.iter().position(|c| c == &on_left)
            .or_else(|| left_cols.iter().position(|c| c == &join.on_left_col))
            .ok_or_else(|| HeapQlError::UnknownColumn(on_left.clone(), stmt.table.to_string()))?;
        let right_key_idx = right_cols.iter().position(|c| c == &on_right)
            .or_else(|| right_cols.iter().position(|c| c == &join.on_right_col))
            .ok_or_else(|| HeapQlError::UnknownColumn(on_right.clone(), join.right.table.to_string()))?;

        // Build combined column list (prefixed with alias)
        let mut combined_cols: Vec<String> = Vec::new();
        for col in &left_cols {
            combined_cols.push(format!("{}.{}", left_alias, col));
        }
        for col in &right_cols {
            combined_cols.push(format!("{}.{}", right_alias, col));
        }

        // Build hash map from right table: key -> Vec<Row>
        let mut right_map: std::collections::HashMap<String, Vec<&Row>> = std::collections::HashMap::new();
        for row in &right_rows {
            let key = json_value_to_join_key(&row[right_key_idx]);
            right_map.entry(key).or_default().push(row);
        }

        let total_scanned = (left_rows.len() + right_rows.len()) as u64;
        let mut combined_rows: Vec<Row> = Vec::new();

        for left_row in &left_rows {
            let key = json_value_to_join_key(&left_row[left_key_idx]);
            if let Some(matches) = right_map.get(&key) {
                for right_row in matches {
                    let mut combined = left_row.clone();
                    combined.extend(right_row.iter().cloned());
                    combined_rows.push(combined);
                }
            } else if join.kind == JoinKind::Left {
                // LEFT JOIN: emit nulls for right side
                let mut combined = left_row.clone();
                for _ in &right_cols {
                    combined.push(serde_json::Value::Null);
                }
                combined_rows.push(combined);
            }
        }

        // Apply WHERE on combined rows
        if let Some(ref wc) = stmt.where_clause {
            combined_rows.retain(|row| eval_where(row, &combined_cols, wc));
        }

        let total_matched = combined_rows.len() as u64;

        // ORDER BY
        if let Some(ref ob) = stmt.order_by {
            let col_idx = combined_cols.iter().position(|c| c == &ob.column || c.ends_with(&format!(".{}", ob.column)))
                .ok_or_else(|| HeapQlError::UnknownColumn(ob.column.clone(), "joined".into()))?;
            combined_rows.sort_by(|a, b| {
                let cmp = compare_json_values(&a[col_idx], &b[col_idx]);
                if ob.descending { cmp.reverse() } else { cmp }
            });
        }

        // LIMIT
        if let Some(lim) = stmt.limit {
            combined_rows.truncate(lim as usize);
        }

        // Projection
        let (result_columns, result_rows) = if stmt.columns.len() == 1 && stmt.columns[0] == "*" {
            (combined_cols, combined_rows)
        } else {
            let indices: Vec<usize> = stmt.columns.iter()
                .filter_map(|c| {
                    combined_cols.iter().position(|cc| cc == c)
                        .or_else(|| combined_cols.iter().position(|cc| cc.ends_with(&format!(".{}", c))))
                })
                .collect();
            let proj_cols: Vec<String> = indices.iter().map(|&i| combined_cols[i].clone()).collect();
            let proj_rows: Vec<Row> = combined_rows.into_iter()
                .map(|row| indices.iter().map(|&i| row[i].clone()).collect())
                .collect();
            (proj_cols, proj_rows)
        };

        Ok(QueryResult {
            columns: result_columns,
            rows: result_rows,
            total_scanned,
            total_matched,
            execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
            page: None,
            total_pages: None,
            total_rows: None,
        })
    }

    /// Pre-resolve subqueries in a WHERE clause, replacing Value::Subquery with resolved values.
    fn resolve_subqueries(&self, clause: &WhereClause, depth: usize) -> Result<WhereClause, HeapQlError> {
        if depth > 3 {
            return Err(HeapQlError::Execution("Subquery nesting depth exceeded (max 3)".into()));
        }
        match clause {
            WhereClause::Condition(cond) => {
                let resolved_value = match &cond.value {
                    Value::Subquery(inner) => {
                        let inner_result = self.execute_select(*inner.clone(), Instant::now())?;
                        if cond.op == CompOp::In {
                            // Collect first column values into a set
                            let set: Vec<serde_json::Value> = inner_result.rows.iter()
                                .filter_map(|row| row.first().cloned())
                                .collect();
                            Value::ResolvedSet(set)
                        } else {
                            // Scalar subquery: must return exactly one row with one column
                            if inner_result.rows.len() != 1 || inner_result.rows[0].len() != 1 {
                                return Err(HeapQlError::Execution(format!(
                                    "Scalar subquery must return exactly one row and one column, got {} rows",
                                    inner_result.rows.len()
                                )));
                            }
                            let val = &inner_result.rows[0][0];
                            if let Some(n) = val.as_u64() {
                                Value::Int(n)
                            } else if let Some(f) = val.as_f64() {
                                Value::Float(f)
                            } else if let Some(s) = val.as_str() {
                                Value::String(s.to_string())
                            } else {
                                Value::String(val.to_string())
                            }
                        }
                    }
                    other => other.clone(),
                };
                Ok(WhereClause::Condition(Condition {
                    column: cond.column.clone(),
                    op: cond.op.clone(),
                    value: resolved_value,
                }))
            }
            WhereClause::And(a, b) => {
                let ra = self.resolve_subqueries(a, depth + 1)?;
                let rb = self.resolve_subqueries(b, depth + 1)?;
                Ok(WhereClause::And(Box::new(ra), Box::new(rb)))
            }
            WhereClause::Or(a, b) => {
                let ra = self.resolve_subqueries(a, depth + 1)?;
                let rb = self.resolve_subqueries(b, depth + 1)?;
                Ok(WhereClause::Or(Box::new(ra), Box::new(rb)))
            }
        }
    }

    fn execute_select(&self, mut stmt: SelectStatement, start: Instant) -> Result<QueryResult, HeapQlError> {
        // Delegate to JOIN executor if a join is present
        if stmt.join.is_some() {
            return self.execute_join(stmt, start);
        }

        // Pre-resolve subqueries in WHERE clause
        if let Some(ref wc) = stmt.where_clause {
            if where_has_subquery(wc) {
                stmt.where_clause = Some(self.resolve_subqueries(wc, 0)?);
            }
        }

        let all_columns: Vec<String> = table_columns(&stmt.table).iter().map(|s| s.to_string()).collect();

        // Check if query uses aggregates
        let has_aggregates = stmt.select_columns.iter().any(|c| matches!(c, SelectColumn::Aggregate(_, _)));
        let has_group_by = stmt.group_by.is_some();

        // Validate: if aggregates are present, non-aggregate columns must be in GROUP BY
        if has_aggregates {
            for sc in &stmt.select_columns {
                if let SelectColumn::Named(ref name) = sc {
                    if let Some(ref gb) = stmt.group_by {
                        if name != gb {
                            return Err(HeapQlError::Parse(format!(
                                "Column '{}' must appear in GROUP BY clause or be used in an aggregate function", name
                            )));
                        }
                    } else {
                        return Err(HeapQlError::Parse(format!(
                            "Column '{}' must appear in GROUP BY clause or be used in an aggregate function", name
                        )));
                    }
                }
            }
            // Validate aggregate column names (skip * for COUNT)
            for sc in &stmt.select_columns {
                if let SelectColumn::Aggregate(_, ref col) = sc {
                    if col != "*" && !all_columns.contains(col) {
                        return Err(HeapQlError::UnknownColumn(col.clone(), stmt.table.to_string()));
                    }
                }
            }
        } else if has_group_by {
            return Err(HeapQlError::Parse("GROUP BY requires at least one aggregate function in SELECT".into()));
        }

        // For non-aggregate queries, validate columns as before
        if !has_aggregates {
            let _selected = validate_columns(&stmt.columns, &stmt.table)?;
        }

        let has_order = stmt.order_by.is_some();
        let limit = stmt.limit.unwrap_or(u64::MAX);
        let mut total_scanned: u64 = 0;
        let mut total_matched: u64 = 0;
        let mut rows: Vec<Row> = Vec::new();

        // Scan table
        match stmt.table {
            TableName::Instances => {
                for (i, (obj_id, node_type, class_name)) in self.node_data_map.iter().enumerate() {
                    // Skip SuperRoot/Root/Class and zero-retained
                    if *node_type == "SuperRoot" || *node_type == "Root" || *node_type == "Class" {
                        continue;
                    }
                    let retained = self.retained_sizes.get(i).copied().unwrap_or(0);
                    if retained == 0 {
                        continue;
                    }

                    total_scanned += 1;

                    let shallow = self.shallow_sizes.get(i).copied().unwrap_or(0);
                    let row: Row = vec![
                        serde_json::json!(*obj_id),
                        serde_json::json!(*node_type),
                        serde_json::json!(class_name.as_ref()),
                        serde_json::json!(shallow),
                        serde_json::json!(retained),
                    ];

                    if let Some(ref wc) = stmt.where_clause {
                        if !eval_where(&row, &all_columns, wc) {
                            continue;
                        }
                    }

                    total_matched += 1;
                    rows.push(row);

                    // Streaming LIMIT: stop early if no ORDER BY
                    if !has_order && total_matched >= limit {
                        break;
                    }
                }
            }
            TableName::ClassHistogram => {
                for entry in &self.class_histogram {
                    total_scanned += 1;
                    let row: Row = vec![
                        serde_json::json!(&entry.class_name),
                        serde_json::json!(entry.instance_count),
                        serde_json::json!(entry.shallow_size),
                        serde_json::json!(entry.retained_size),
                    ];

                    if let Some(ref wc) = stmt.where_clause {
                        if !eval_where(&row, &all_columns, wc) {
                            continue;
                        }
                    }

                    total_matched += 1;
                    rows.push(row);

                    if !has_order && total_matched >= limit {
                        break;
                    }
                }
            }
            TableName::DominatorTree => {
                // Determine which node's children to return
                let parent_id = self.extract_object_id_from_where(&stmt.where_clause);
                let parent_idx = match parent_id {
                    Some(id) => {
                        self.id_to_node.get(&id).copied()
                            .ok_or_else(|| HeapQlError::Execution(format!("Object {} not found", id)))?
                    }
                    None => self.super_root,
                };
                // Strip object_id = X from WHERE since it selects the parent, not filters children
                let child_where = Self::strip_object_id_from_where(&stmt.where_clause);

                if let Some(children) = self.children_map.get(&parent_idx) {
                    for &child_idx in children {
                        let i = child_idx.index();
                        let (obj_id, node_type, class_name) = if i < self.node_data_map.len() {
                            let (id, nt, ref cn) = self.node_data_map[i];
                            (id, nt, cn.clone())
                        } else {
                            continue;
                        };

                        if node_type == "Class" {
                            continue;
                        }
                        let retained = self.retained_sizes.get(i).copied().unwrap_or(0);
                        if retained == 0 {
                            continue;
                        }

                        total_scanned += 1;
                        let shallow = self.shallow_sizes.get(i).copied().unwrap_or(0);
                        let row: Row = vec![
                            serde_json::json!(obj_id),
                            serde_json::json!(node_type),
                            serde_json::json!(class_name.as_ref()),
                            serde_json::json!(shallow),
                            serde_json::json!(retained),
                        ];

                        // Apply remaining WHERE conditions (object_id = X already consumed)
                        if let Some(ref wc) = child_where {
                            if !eval_where(&row, &all_columns, wc) {
                                continue;
                            }
                        }

                        total_matched += 1;
                        rows.push(row);

                        if !has_order && total_matched >= limit {
                            break;
                        }
                    }
                }
            }
            TableName::LeakSuspects => {
                for suspect in &self.leak_suspects {
                    total_scanned += 1;
                    let row: Row = vec![
                        serde_json::json!(&suspect.class_name),
                        serde_json::json!(suspect.object_id),
                        serde_json::json!(suspect.retained_size),
                        serde_json::json!(suspect.retained_percentage),
                        serde_json::json!(&suspect.description),
                    ];

                    if let Some(ref wc) = stmt.where_clause {
                        if !eval_where(&row, &all_columns, wc) {
                            continue;
                        }
                    }

                    total_matched += 1;
                    rows.push(row);

                    if !has_order && total_matched >= limit {
                        break;
                    }
                }
            }
        }

        // AGGREGATION
        if has_aggregates {
            if has_group_by {
                let gb_col = stmt.group_by.as_ref().unwrap();
                let gb_idx = all_columns.iter().position(|c| c == gb_col)
                    .ok_or_else(|| HeapQlError::UnknownColumn(gb_col.clone(), stmt.table.to_string()))?;

                // Group rows by the GROUP BY column value
                let mut groups: std::collections::HashMap<String, Vec<Row>> = std::collections::HashMap::new();
                let mut group_order: Vec<String> = Vec::new();
                for row in &rows {
                    let key = match &row[gb_idx] {
                        serde_json::Value::String(s) => s.clone(),
                        v => v.to_string(),
                    };
                    if !groups.contains_key(&key) {
                        group_order.push(key.clone());
                    }
                    groups.entry(key).or_default().push(row.clone());
                }

                // Build result columns and rows
                let mut agg_columns: Vec<String> = Vec::new();
                for sc in &stmt.select_columns {
                    match sc {
                        SelectColumn::Named(n) => agg_columns.push(n.clone()),
                        SelectColumn::Aggregate(func, col) => agg_columns.push(format!("{}({})", func, col)),
                        SelectColumn::Star => agg_columns.push("*".into()),
                    }
                }

                let mut agg_rows: Vec<Row> = Vec::new();
                for key in &group_order {
                    let group_rows = &groups[key];
                    let mut row_vals: Vec<serde_json::Value> = Vec::new();
                    for sc in &stmt.select_columns {
                        match sc {
                            SelectColumn::Named(_) => {
                                row_vals.push(serde_json::json!(key));
                            }
                            SelectColumn::Aggregate(func, col) => {
                                row_vals.push(compute_aggregate(func, col, group_rows, &all_columns));
                            }
                            SelectColumn::Star => {
                                row_vals.push(serde_json::json!(key));
                            }
                        }
                    }
                    agg_rows.push(row_vals);
                }

                total_matched = agg_rows.len() as u64;
                rows = agg_rows;

                // ORDER BY on aggregate results
                if let Some(ref ob) = stmt.order_by {
                    let col_idx = agg_columns.iter().position(|c| c == &ob.column)
                        .ok_or_else(|| HeapQlError::UnknownColumn(ob.column.clone(), stmt.table.to_string()))?;
                    rows.sort_by(|a, b| {
                        let cmp = compare_json_values(&a[col_idx], &b[col_idx]);
                        if ob.descending { cmp.reverse() } else { cmp }
                    });
                }

                if let Some(lim) = stmt.limit {
                    rows.truncate(lim as usize);
                }

                return Ok(QueryResult {
                    columns: agg_columns,
                    rows,
                    total_scanned,
                    total_matched,
                    execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                    page: None, total_pages: None, total_rows: None,
                });
            } else {
                // No GROUP BY — single-row aggregate result
                let mut agg_columns: Vec<String> = Vec::new();
                let mut agg_row: Vec<serde_json::Value> = Vec::new();
                for sc in &stmt.select_columns {
                    match sc {
                        SelectColumn::Aggregate(func, col) => {
                            let col_name = format!("{}({})", func, col);
                            agg_columns.push(col_name);
                            agg_row.push(compute_aggregate(func, col, &rows, &all_columns));
                        }
                        _ => {
                            // Already validated above: shouldn't happen
                            return Err(HeapQlError::Parse("Cannot mix aggregate and non-aggregate columns without GROUP BY".into()));
                        }
                    }
                }

                return Ok(QueryResult {
                    columns: agg_columns,
                    rows: vec![agg_row],
                    total_scanned,
                    total_matched,
                    execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                    page: None, total_pages: None, total_rows: None,
                });
            }
        }

        // ORDER BY
        if let Some(ref ob) = stmt.order_by {
            let col_idx = all_columns.iter().position(|c| c == &ob.column)
                .ok_or_else(|| HeapQlError::UnknownColumn(ob.column.clone(), stmt.table.to_string()))?;
            rows.sort_by(|a, b| {
                let cmp = compare_json_values(&a[col_idx], &b[col_idx]);
                if ob.descending { cmp.reverse() } else { cmp }
            });
        }

        // LIMIT (post-sort)
        if has_order {
            rows.truncate(limit as usize);
        }

        // Column projection: if not *, only keep selected columns
        let (result_columns, result_rows) = if stmt.columns.len() == 1 && stmt.columns[0] == "*" {
            (all_columns, rows)
        } else {
            let indices: Vec<usize> = stmt.columns.iter()
                .filter_map(|c| all_columns.iter().position(|ac| ac == c))
                .collect();
            let proj_cols: Vec<String> = indices.iter().map(|&i| all_columns[i].clone()).collect();
            let proj_rows: Vec<Row> = rows.into_iter()
                .map(|row| indices.iter().map(|&i| row[i].clone()).collect())
                .collect();
            (proj_cols, proj_rows)
        };

        Ok(QueryResult {
            columns: result_columns,
            rows: result_rows,
            total_scanned,
            total_matched,
            execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
            page: None,
            total_pages: None,
            total_rows: None,
        })
    }

    /// Execute a query with server-side pagination.
    pub fn execute_query_paged(&self, query_str: &str, page: u64, page_size: u64) -> Result<QueryResult, HeapQlError> {
        let page = if page == 0 { 1 } else { page };
        let page_size = if page_size == 0 { 500 } else { page_size };
        let mut result = self.execute_query(query_str)?;
        let total = result.rows.len() as u64;
        let total_pages = if total == 0 { 1 } else { (total + page_size - 1) / page_size };
        let start_idx = ((page - 1) * page_size) as usize;
        let end_idx = (start_idx + page_size as usize).min(result.rows.len());
        result.rows = if start_idx < result.rows.len() {
            result.rows[start_idx..end_idx].to_vec()
        } else {
            vec![]
        };
        result.page = Some(page);
        result.total_pages = Some(total_pages);
        result.total_rows = Some(total);
        Ok(result)
    }

    /// Extract object_id = X from a WHERE clause for dominator_tree queries.
    fn extract_object_id_from_where(&self, wc: &Option<WhereClause>) -> Option<u64> {
        match wc {
            Some(WhereClause::Condition(c)) if c.column == "object_id" && c.op == CompOp::Eq => {
                match &c.value {
                    Value::Int(n) => Some(*n),
                    _ => None,
                }
            }
            Some(WhereClause::And(a, _)) => self.extract_object_id_from_where(&Some(*a.clone())),
            _ => None,
        }
    }

    /// Remove the `object_id = X` condition from WHERE for dominator_tree,
    /// since it's consumed to select the parent node, not to filter children.
    fn strip_object_id_from_where(wc: &Option<WhereClause>) -> Option<WhereClause> {
        match wc {
            None => None,
            Some(WhereClause::Condition(c)) if c.column == "object_id" && c.op == CompOp::Eq => None,
            Some(WhereClause::And(a, b)) => {
                let stripped_a = Self::strip_object_id_from_where(&Some(*a.clone()));
                let stripped_b = Self::strip_object_id_from_where(&Some(*b.clone()));
                match (stripped_a, stripped_b) {
                    (Some(a), Some(b)) => Some(WhereClause::And(Box::new(a), Box::new(b))),
                    (Some(a), None) => Some(a),
                    (None, Some(b)) => Some(b),
                    (None, None) => None,
                }
            }
            other => other.clone(),
        }
    }

    fn execute_special(&self, cmd: SpecialCommand, start: Instant) -> Result<QueryResult, HeapQlError> {
        match cmd {
            SpecialCommand::Path(id) => {
                let path = self.gc_root_path(id, 100)
                    .ok_or_else(|| HeapQlError::Execution(format!("No GC root path found for object {}", id)))?;
                Ok(reports_to_result(path, start))
            }
            SpecialCommand::Refs(id) => {
                let node_idx = self.id_to_node.get(&id)
                    .ok_or_else(|| HeapQlError::Execution(format!("Object {} not found", id)))?;
                let referrers = self.get_reverse_refs().get(node_idx)
                    .map(|refs| {
                        refs.iter()
                            .filter_map(|&(idx, _)| self.node_to_report(idx))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Ok(reports_to_result(referrers, start))
            }
            SpecialCommand::Children(id) => {
                let children = self.get_children(id)
                    .ok_or_else(|| HeapQlError::Execution(format!("Object {} has no children or not found", id)))?;
                Ok(reports_to_result(children, start))
            }
            SpecialCommand::Info(id) => {
                let node_idx = *self.id_to_node.get(&id)
                    .ok_or_else(|| HeapQlError::Execution(format!("Object {} not found", id)))?;
                let report = self.node_to_report(node_idx)
                    .ok_or_else(|| HeapQlError::Execution(format!("Could not build report for object {}", id)))?;

                let child_count = self.children_map.get(&node_idx).map(|c| c.len()).unwrap_or(0);
                let ref_count = self.get_reverse_refs().get(&node_idx).map(|r| r.len()).unwrap_or(0);

                let columns = vec![
                    "object_id".into(), "node_type".into(), "class_name".into(),
                    "shallow_size".into(), "retained_size".into(),
                    "child_count".into(), "referrer_count".into(),
                ];
                let row = vec![
                    serde_json::json!(report.object_id),
                    serde_json::json!(report.node_type),
                    serde_json::json!(report.class_name),
                    serde_json::json!(report.shallow_size),
                    serde_json::json!(report.retained_size),
                    serde_json::json!(child_count),
                    serde_json::json!(ref_count),
                ];

                Ok(QueryResult {
                    columns,
                    rows: vec![row],
                    total_scanned: 1,
                    total_matched: 1,
                    execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
                    page: None, total_pages: None, total_rows: None,
                })
            }
        }
    }

    /// Builds an ObjectReport from a node index.
    fn node_to_report(&self, idx: NodeIndex) -> Option<ObjectReport> {
        let i = idx.index();
        if i >= self.node_data_map.len() {
            return None;
        }
        let (obj_id, node_type, ref class_name) = self.node_data_map[i];
        let shallow = self.shallow_sizes.get(i).copied().unwrap_or(0);
        let retained = self.retained_sizes.get(i).copied().unwrap_or(0);
        Some(ObjectReport::new(
            obj_id,
            node_type.to_string(),
            class_name.to_string(),
            shallow,
            retained,
            idx,
        ))
    }
}

fn compute_aggregate(func: &AggFunc, col: &str, rows: &[Row], all_columns: &[String]) -> serde_json::Value {
    match func {
        AggFunc::Count => {
            if col == "*" {
                serde_json::json!(rows.len() as u64)
            } else {
                // Count non-null values in column
                let col_idx = all_columns.iter().position(|c| c == col);
                match col_idx {
                    Some(idx) => {
                        let count = rows.iter().filter(|r| !r[idx].is_null()).count();
                        serde_json::json!(count as u64)
                    }
                    None => serde_json::json!(0),
                }
            }
        }
        AggFunc::Sum | AggFunc::Avg | AggFunc::Min | AggFunc::Max => {
            let col_idx = match all_columns.iter().position(|c| c == col) {
                Some(idx) => idx,
                None => return serde_json::json!(0),
            };
            let values: Vec<f64> = rows.iter()
                .filter_map(|r| r[col_idx].as_f64().or_else(|| r[col_idx].as_u64().map(|n| n as f64)))
                .collect();
            if values.is_empty() {
                return serde_json::json!(null);
            }
            match func {
                AggFunc::Sum => {
                    let sum: f64 = values.iter().sum();
                    if sum == (sum as u64) as f64 { serde_json::json!(sum as u64) } else { serde_json::json!(sum) }
                }
                AggFunc::Avg => {
                    let sum: f64 = values.iter().sum();
                    let avg = sum / values.len() as f64;
                    serde_json::json!((avg * 100.0).round() / 100.0)
                }
                AggFunc::Min => {
                    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
                    if min == (min as u64) as f64 { serde_json::json!(min as u64) } else { serde_json::json!(min) }
                }
                AggFunc::Max => {
                    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                    if max == (max as u64) as f64 { serde_json::json!(max as u64) } else { serde_json::json!(max) }
                }
                _ => unreachable!(),
            }
        }
    }
}

fn reports_to_result(reports: Vec<ObjectReport>, start: Instant) -> QueryResult {
    let len = reports.len() as u64;
    let columns = vec![
        "object_id".into(), "node_type".into(), "class_name".into(),
        "shallow_size".into(), "retained_size".into(),
    ];
    let rows: Vec<Row> = reports.into_iter().map(|r| {
        vec![
            serde_json::json!(r.object_id),
            serde_json::json!(r.node_type),
            serde_json::json!(r.class_name),
            serde_json::json!(r.shallow_size),
            serde_json::json!(r.retained_size),
        ]
    }).collect();

    QueryResult {
        columns,
        rows,
        total_scanned: len,
        total_matched: len,
        execution_time_ms: start.elapsed().as_secs_f64() * 1000.0,
        page: None,
        total_pages: None,
        total_rows: None,
    }
}

/// Convert a JSON value to a string key for hash join lookups.
fn json_value_to_join_key(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Strip alias prefix from a qualified column name.
/// E.g., "i.class_name" with alias "i" -> "class_name".
fn strip_alias_prefix(col: &str, left_alias: &str, right_alias: &str) -> String {
    if let Some(dot_pos) = col.find('.') {
        let prefix = &col[..dot_pos];
        if prefix == left_alias || prefix == right_alias {
            return col[dot_pos + 1..].to_string();
        }
    }
    col.to_string()
}

/// Check if a WHERE clause contains any subqueries that need resolution.
fn where_has_subquery(clause: &WhereClause) -> bool {
    match clause {
        WhereClause::Condition(cond) => matches!(cond.value, Value::Subquery(_)),
        WhereClause::And(a, b) | WhereClause::Or(a, b) => where_has_subquery(a) || where_has_subquery(b),
    }
}

// ============================================================================
// Unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use crate::{ClassHistogramEntry, EdgeLabel, LeakSuspect, HeapSummary, WasteAnalysis};
    use std::collections::HashMap;
    use std::sync::{Arc, OnceLock};

    /// Build a synthetic AnalysisState for testing (no .hprof needed).
    fn build_test_state() -> AnalysisState {
        // 6 nodes: SuperRoot(0), Root(1), Instance "HashMap"(2), Instance "ArrayList"(3),
        //          Array "byte[]"(4), Instance "CacheManager"(5)
        let mut node_data_map: Vec<(u64, &'static str, Arc<str>)> = Vec::new();
        node_data_map.push((0, "SuperRoot", Arc::from("")));       // idx 0
        node_data_map.push((0, "Root", Arc::from("")));            // idx 1
        node_data_map.push((100, "Instance", Arc::from("java.util.HashMap")));  // idx 2
        node_data_map.push((200, "Instance", Arc::from("java.util.ArrayList"))); // idx 3
        node_data_map.push((300, "Array", Arc::from("byte[]")));    // idx 4
        node_data_map.push((400, "Instance", Arc::from("com.app.CacheManager"))); // idx 5

        let shallow_sizes = vec![0, 0, 48, 40, 1024, 32];
        let retained_sizes = vec![0, 0, 2048, 1024, 1024, 4096];

        let mut id_to_node = HashMap::new();
        id_to_node.insert(100, NodeIndex::new(2));
        id_to_node.insert(200, NodeIndex::new(3));
        id_to_node.insert(300, NodeIndex::new(4));
        id_to_node.insert(400, NodeIndex::new(5));

        let mut children_map: HashMap<NodeIndex, Vec<NodeIndex>> = HashMap::new();
        // SuperRoot -> Root
        children_map.insert(NodeIndex::new(0), vec![NodeIndex::new(1)]);
        // Root -> HashMap, CacheManager
        children_map.insert(NodeIndex::new(1), vec![NodeIndex::new(2), NodeIndex::new(5)]);
        // HashMap -> ArrayList
        children_map.insert(NodeIndex::new(2), vec![NodeIndex::new(3)]);
        // ArrayList -> byte[]
        children_map.insert(NodeIndex::new(3), vec![NodeIndex::new(4)]);

        let forward_edges: Vec<(u32, u32, EdgeLabel)> = vec![
            (1, 2, EdgeLabel::Unknown),
            (2, 3, EdgeLabel::Unknown),
            (3, 4, EdgeLabel::Unknown),
            (1, 5, EdgeLabel::Unknown),
        ];

        let class_histogram = vec![
            ClassHistogramEntry {
                class_name: "com.app.CacheManager".into(),
                instance_count: 1,
                shallow_size: 32,
                retained_size: 4096,
            },
            ClassHistogramEntry {
                class_name: "java.util.HashMap".into(),
                instance_count: 5,
                shallow_size: 240,
                retained_size: 2048,
            },
            ClassHistogramEntry {
                class_name: "byte[]".into(),
                instance_count: 10,
                shallow_size: 10240,
                retained_size: 1024,
            },
        ];

        let leak_suspects = vec![
            LeakSuspect {
                class_name: "com.app.CacheManager".into(),
                object_id: 400,
                retained_size: 4096,
                retained_percentage: 50.0,
                description: "Retains 50% of heap".into(),
            },
        ];

        let summary = HeapSummary {
            total_heap_size: 8192,
            reachable_heap_size: 8192,
            total_instances: 4,
            total_classes: 3,
            total_arrays: 1,
            total_gc_roots: 1,
            hprof_version: String::new(),
            heap_types: Vec::new(),
        };

        AnalysisState {
            children_map,
            retained_sizes,
            shallow_sizes,
            id_to_node,
            super_root: NodeIndex::new(0),
            node_data_map,
            class_histogram,
            leak_suspects,
            summary,
            forward_edges,
            reverse_refs: OnceLock::new(),
            waste_analysis: WasteAnalysis {
                total_wasted_bytes: 0,
                waste_percentage: 0.0,
                duplicate_string_wasted_bytes: 0,
                empty_collection_wasted_bytes: 0,
                over_allocated_wasted_bytes: 0,
                boxed_primitive_wasted_bytes: 0,
                duplicate_strings: vec![],
                empty_collections: vec![],
                over_allocated_collections: vec![],
                boxed_primitives: vec![],
            },
            field_name_table: vec![],
            class_field_layouts: std::collections::HashMap::new(),
            id_size: jvm_hprof::IdSize::U64,
        }
    }

    // -- Tokenizer tests --

    #[test]
    fn test_tokenize_select() {
        let mut t = Tokenizer::new("SELECT * FROM instances");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::Select, Token::Star, Token::From, Token::Ident("instances".into()), Token::Eof]);
    }

    #[test]
    fn test_tokenize_where_like() {
        let mut t = Tokenizer::new("WHERE class_name LIKE '%Cache%'");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![
            Token::Where,
            Token::Ident("class_name".into()),
            Token::Like,
            Token::StringLit("%Cache%".into()),
            Token::Eof,
        ]);
    }

    #[test]
    fn test_tokenize_size_suffixes() {
        let mut t = Tokenizer::new("250KB");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::IntLit(256000), Token::Eof]);

        let mut t = Tokenizer::new("250 KB");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::IntLit(256000), Token::Eof]);

        let mut t = Tokenizer::new("1MB");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::IntLit(1048576), Token::Eof]);

        let mut t = Tokenizer::new("2GB");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::IntLit(2147483648), Token::Eof]);

        let mut t = Tokenizer::new("100B");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::IntLit(100), Token::Eof]);

        // 1.5 MB
        let mut t = Tokenizer::new("1.5MB");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::IntLit(1572864), Token::Eof]);
    }

    #[test]
    fn test_size_suffix_in_query() {
        let state = build_test_state();
        // byte[] has shallow_size=1024, CacheManager=32, HashMap=48, ArrayList=40
        // Only byte[](1024) should match > 250 KB (256000)? No, all are < 256000.
        // Let's test > 1 KB (1024) — nothing matches since max shallow is 1024 (not >).
        // Test >= 1KB — byte[] with shallow 1024 matches.
        let result = state.execute_query("SELECT * FROM instances WHERE shallow_size >= 1KB").unwrap();
        assert_eq!(result.total_matched, 1);
        assert_eq!(result.rows[0][2], serde_json::json!("byte[]"));
    }

    #[test]
    fn test_tokenize_operators() {
        let mut t = Tokenizer::new(">= <= != = > <");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::Gte, Token::Lte, Token::Neq, Token::Eq, Token::Gt, Token::Lt, Token::Eof]);
    }

    #[test]
    fn test_tokenize_special() {
        let mut t = Tokenizer::new(":path 12345");
        let tokens = t.tokenize().unwrap();
        assert_eq!(tokens, vec![Token::Colon, Token::Ident("path".into()), Token::IntLit(12345), Token::Eof]);
    }

    // -- Parser tests --

    #[test]
    fn test_parse_select_star() {
        let mut t = Tokenizer::new("SELECT * FROM class_histogram ORDER BY retained_size DESC LIMIT 5");
        let tokens = t.tokenize().unwrap();
        let mut p = Parser::new(tokens);
        let stmt = p.parse().unwrap();
        match stmt {
            Statement::Select(s) => {
                assert_eq!(s.columns, vec!["*"]);
                assert_eq!(s.table, TableName::ClassHistogram);
                assert!(s.order_by.is_some());
                let ob = s.order_by.unwrap();
                assert_eq!(ob.column, "retained_size");
                assert!(ob.descending);
                assert_eq!(s.limit, Some(5));
            }
            _ => panic!("Expected Select statement"),
        }
    }

    #[test]
    fn test_parse_where_and() {
        let mut t = Tokenizer::new("SELECT * FROM instances WHERE class_name LIKE '%HashMap%' AND retained_size > 1000");
        let tokens = t.tokenize().unwrap();
        let mut p = Parser::new(tokens);
        let stmt = p.parse().unwrap();
        match stmt {
            Statement::Select(s) => {
                assert!(s.where_clause.is_some());
                match s.where_clause.unwrap() {
                    WhereClause::And(_, _) => {} // OK
                    other => panic!("Expected And, got {:?}", other),
                }
            }
            _ => panic!("Expected Select"),
        }
    }

    #[test]
    fn test_parse_special_command() {
        let mut t = Tokenizer::new(":info 400");
        let tokens = t.tokenize().unwrap();
        let mut p = Parser::new(tokens);
        let stmt = p.parse().unwrap();
        match stmt {
            Statement::Special(SpecialCommand::Info(id)) => assert_eq!(id, 400),
            _ => panic!("Expected Special Info"),
        }
    }

    #[test]
    fn test_parse_error_unknown_table() {
        let mut t = Tokenizer::new("SELECT * FROM bogus_table");
        let tokens = t.tokenize().unwrap();
        let mut p = Parser::new(tokens);
        let result = p.parse();
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, HeapQlError::UnknownTable(_)));
    }

    // -- Executor tests --

    #[test]
    fn test_select_star_from_class_histogram() {
        let state = build_test_state();
        let result = state.execute_query("SELECT * FROM class_histogram").unwrap();
        assert_eq!(result.columns, vec!["class_name", "instance_count", "shallow_size", "retained_size"]);
        assert_eq!(result.rows.len(), 3);
        assert_eq!(result.total_matched, 3);
    }

    #[test]
    fn test_select_with_where_like() {
        let state = build_test_state();
        let result = state.execute_query("SELECT * FROM instances WHERE class_name LIKE '%HashMap%'").unwrap();
        assert_eq!(result.total_matched, 1);
        assert_eq!(result.rows[0][2], serde_json::json!("java.util.HashMap"));
    }

    #[test]
    fn test_select_order_by_desc_limit() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT * FROM class_histogram ORDER BY retained_size DESC LIMIT 2"
        ).unwrap();
        assert_eq!(result.rows.len(), 2);
        // First row should be CacheManager (4096), second HashMap (2048)
        assert_eq!(result.rows[0][0], serde_json::json!("com.app.CacheManager"));
        assert_eq!(result.rows[1][0], serde_json::json!("java.util.HashMap"));
    }

    #[test]
    fn test_select_instances_with_size_filter() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT * FROM instances WHERE retained_size >= 2048"
        ).unwrap();
        assert!(result.total_matched >= 1);
        for row in &result.rows {
            let retained = row[4].as_u64().unwrap();
            assert!(retained >= 2048);
        }
    }

    #[test]
    fn test_select_leak_suspects() {
        let state = build_test_state();
        let result = state.execute_query("SELECT * FROM leak_suspects").unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!("com.app.CacheManager"));
    }

    #[test]
    fn test_select_specific_columns() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT class_name, retained_size FROM class_histogram LIMIT 1"
        ).unwrap();
        assert_eq!(result.columns, vec!["class_name", "retained_size"]);
        assert_eq!(result.rows[0].len(), 2);
    }

    #[test]
    fn test_special_info() {
        let state = build_test_state();
        let result = state.execute_query(":info 400").unwrap();
        assert_eq!(result.columns.len(), 7);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!(400));
        assert_eq!(result.rows[0][2], serde_json::json!("com.app.CacheManager"));
    }

    #[test]
    fn test_special_children() {
        let state = build_test_state();
        let result = state.execute_query(":children 100").unwrap();
        // HashMap(100) -> ArrayList(200) in the test dominator tree
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!(200));
    }

    #[test]
    fn test_special_refs() {
        let state = build_test_state();
        let result = state.execute_query(":refs 100").unwrap();
        // HashMap(100) is referenced by Root(idx 1) — but Root has obj_id 0 and type "Root"
        assert!(result.rows.len() >= 1);
    }

    #[test]
    fn test_error_unknown_column() {
        let state = build_test_state();
        let result = state.execute_query("SELECT bogus FROM class_histogram");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), HeapQlError::UnknownColumn(_, _)));
    }

    #[test]
    fn test_like_matching() {
        assert!(like_match("java.util.HashMap", "%HashMap%"));
        assert!(like_match("java.util.HashMap", "%HashMap"));
        assert!(like_match("java.util.HashMap", "java%"));
        assert!(like_match("java.util.HashMap", "java.util.HashMap"));
        assert!(!like_match("java.util.HashMap", "%TreeMap%"));
        // Case-insensitive
        assert!(like_match("java.util.HashMap", "%hashmap%"));
    }

    #[test]
    fn test_dominator_tree_query() {
        let state = build_test_state();
        // Query children of HashMap(100) — should return ArrayList(200)
        let result = state.execute_query("SELECT * FROM dominator_tree WHERE object_id = 100").unwrap();
        // HashMap(100) children: ArrayList(200)
        assert!(result.rows.len() >= 1);
    }

    #[test]
    fn test_streaming_limit_no_order() {
        let state = build_test_state();
        let result = state.execute_query("SELECT * FROM instances LIMIT 2").unwrap();
        assert!(result.rows.len() <= 2);
    }

    // -- Aggregation tests --

    #[test]
    fn test_count_star() {
        let state = build_test_state();
        let result = state.execute_query("SELECT COUNT(*) FROM instances").unwrap();
        assert_eq!(result.columns, vec!["count(*)"]);
        assert_eq!(result.rows.len(), 1);
        // 4 instances in test state (HashMap, ArrayList, byte[], CacheManager)
        assert_eq!(result.rows[0][0], serde_json::json!(4));
    }

    #[test]
    fn test_sum_retained_size() {
        let state = build_test_state();
        let result = state.execute_query("SELECT SUM(retained_size) FROM instances").unwrap();
        assert_eq!(result.columns, vec!["sum(retained_size)"]);
        assert_eq!(result.rows.len(), 1);
        // 2048 + 1024 + 1024 + 4096 = 8192
        assert_eq!(result.rows[0][0], serde_json::json!(8192));
    }

    #[test]
    fn test_avg_shallow_size() {
        let state = build_test_state();
        let result = state.execute_query("SELECT AVG(shallow_size) FROM instances").unwrap();
        assert_eq!(result.columns, vec!["avg(shallow_size)"]);
        assert_eq!(result.rows.len(), 1);
        // (48 + 40 + 1024 + 32) / 4 = 286.0
        assert_eq!(result.rows[0][0], serde_json::json!(286.0));
    }

    #[test]
    fn test_min_max_retained() {
        let state = build_test_state();
        let result = state.execute_query("SELECT MIN(retained_size), MAX(retained_size) FROM instances").unwrap();
        assert_eq!(result.columns, vec!["min(retained_size)", "max(retained_size)"]);
        assert_eq!(result.rows[0][0], serde_json::json!(1024));
        assert_eq!(result.rows[0][1], serde_json::json!(4096));
    }

    #[test]
    fn test_count_with_where() {
        let state = build_test_state();
        let result = state.execute_query("SELECT COUNT(*) FROM instances WHERE retained_size > 1024").unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!(2)); // HashMap(2048), CacheManager(4096)
    }

    #[test]
    fn test_mixed_aggregate_plain_error() {
        let state = build_test_state();
        let result = state.execute_query("SELECT class_name, COUNT(*) FROM instances");
        assert!(result.is_err());
    }

    #[test]
    fn test_count_star_class_histogram() {
        let state = build_test_state();
        let result = state.execute_query("SELECT COUNT(*), SUM(instance_count) FROM class_histogram").unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!(3)); // 3 histogram entries
        assert_eq!(result.rows[0][1], serde_json::json!(16)); // 1 + 5 + 10
    }

    // -- GROUP BY tests --

    #[test]
    fn test_group_by_with_count() {
        let state = build_test_state();
        // Group by node_type in instances — should get "Instance" and "Array" groups
        let result = state.execute_query(
            "SELECT node_type, COUNT(*) FROM instances GROUP BY node_type ORDER BY count(*) DESC"
        ).unwrap();
        assert!(result.rows.len() >= 2);
        assert_eq!(result.columns, vec!["node_type", "count(*)"]);
        // Instance group should have 3 (HashMap, ArrayList, CacheManager), Array has 1 (byte[])
        assert_eq!(result.rows[0][0], serde_json::json!("Instance"));
        assert_eq!(result.rows[0][1], serde_json::json!(3));
    }

    #[test]
    fn test_group_by_with_sum() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT node_type, SUM(retained_size) FROM instances GROUP BY node_type"
        ).unwrap();
        assert!(result.rows.len() >= 2);
    }

    #[test]
    fn test_group_by_invalid_non_grouped_column() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT class_name, COUNT(*) FROM instances GROUP BY node_type"
        );
        assert!(result.is_err());
    }

    // -- JOIN tests --

    #[test]
    fn test_join_instances_class_histogram() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT * FROM instances i JOIN class_histogram c ON class_name = class_name"
        ).unwrap();
        // Each instance row should match its class in the histogram
        assert!(result.rows.len() >= 1);
        // Combined columns: instances cols prefixed with "i.", histogram cols with "c."
        assert!(result.columns.iter().any(|c| c.starts_with("i.")));
        assert!(result.columns.iter().any(|c| c.starts_with("c.")));
    }

    #[test]
    fn test_left_join_no_match() {
        let state = build_test_state();
        // LEFT JOIN leak_suspects — only CacheManager has a leak suspect entry
        let result = state.execute_query(
            "SELECT * FROM instances i LEFT JOIN leak_suspects l ON class_name = class_name"
        ).unwrap();
        // Should return all 4 instances, with nulls for non-matching leak_suspect columns
        assert_eq!(result.rows.len(), 4);
        // Check that some right-side columns are null (for non-CacheManager instances)
        let null_count = result.rows.iter()
            .filter(|row| row.last().map_or(false, |v| v.is_null()))
            .count();
        assert!(null_count >= 3); // 3 instances without leak suspect match
    }

    #[test]
    fn test_join_with_where() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT * FROM instances i JOIN class_histogram c ON class_name = class_name WHERE i.retained_size > 1024"
        ).unwrap();
        // Should only include instances with retained_size > 1024
        for row in &result.rows {
            // i.retained_size is at index 4 (5th column of left table)
            let ret_idx = result.columns.iter().position(|c| c == "i.retained_size").unwrap();
            assert!(row[ret_idx].as_u64().unwrap() > 1024);
        }
    }

    #[test]
    fn test_join_with_alias() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT * FROM instances AS i INNER JOIN class_histogram AS c ON class_name = class_name LIMIT 2"
        ).unwrap();
        assert!(result.rows.len() <= 2);
    }

    // -- Subquery tests --

    #[test]
    fn test_subquery_scalar_avg() {
        let state = build_test_state();
        // AVG(retained_size) of instances = (2048 + 1024 + 1024 + 4096) / 4 = 2048
        let result = state.execute_query(
            "SELECT * FROM instances WHERE retained_size > (SELECT AVG(retained_size) FROM instances)"
        ).unwrap();
        // Only CacheManager(4096) > 2048
        assert_eq!(result.total_matched, 1);
        assert_eq!(result.rows[0][2], serde_json::json!("com.app.CacheManager"));
    }

    #[test]
    fn test_subquery_in() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT * FROM instances WHERE class_name IN (SELECT class_name FROM leak_suspects)"
        ).unwrap();
        // Only CacheManager is in leak_suspects
        assert_eq!(result.total_matched, 1);
        assert_eq!(result.rows[0][2], serde_json::json!("com.app.CacheManager"));
    }

    #[test]
    fn test_scalar_subquery_multiple_rows_error() {
        let state = build_test_state();
        let result = state.execute_query(
            "SELECT * FROM instances WHERE retained_size > (SELECT retained_size FROM instances)"
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("exactly one row"));
    }

    // -- Pagination tests --

    #[test]
    fn test_pagination_page1() {
        let state = build_test_state();
        let result = state.execute_query_paged("SELECT * FROM instances", 1, 2).unwrap();
        assert_eq!(result.page, Some(1));
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.total_rows, Some(4));
        assert_eq!(result.total_pages, Some(2));
    }

    #[test]
    fn test_pagination_page2() {
        let state = build_test_state();
        let result = state.execute_query_paged("SELECT * FROM instances", 2, 2).unwrap();
        assert_eq!(result.page, Some(2));
        assert_eq!(result.rows.len(), 2);
    }

    #[test]
    fn test_pagination_beyond_last_page() {
        let state = build_test_state();
        let result = state.execute_query_paged("SELECT * FROM instances", 10, 2).unwrap();
        assert_eq!(result.page, Some(10));
        assert_eq!(result.rows.len(), 0);
    }
}
