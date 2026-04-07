-- Usage tracking table for free-tier AI calls
create table if not exists usage (
  user_id text not null,
  date text not null,
  count int not null default 0,
  primary key (user_id, date)
);
