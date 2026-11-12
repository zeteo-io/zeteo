CREATE SCHEMA sales;
CREATE SCHEMA hr;

CREATE TABLE sales.customers (
  id integer PRIMARY KEY,
  name text NOT NULL,
  region text,
  email text
);

CREATE TABLE sales.orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES sales.customers (id),
  status text NOT NULL,
  total numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

CREATE TABLE sales.order_lines (
  order_id integer NOT NULL REFERENCES sales.orders (id),
  line_no integer NOT NULL,
  sku text NOT NULL,
  qty integer NOT NULL,
  price numeric NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE VIEW sales.paid_orders AS
  SELECT id, customer_id, total FROM sales.orders WHERE status = 'paid';

CREATE TABLE sales.blobs (
  id integer,
  data bytea,
  tags text[]
);

CREATE TABLE hr.salaries (
  employee text,
  amount numeric
);

INSERT INTO sales.customers VALUES (1, 'Acme', 'EU', 'a@example.com');
INSERT INTO sales.orders VALUES (1, 1, 'paid', 10, now(), NULL);

GRANT USAGE ON SCHEMA sales TO zeteo_ro, zeteo_rw, zeteo_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO zeteo_ro, zeteo_rw, zeteo_owner;
GRANT INSERT ON sales.orders TO zeteo_rw;
ALTER TABLE sales.customers OWNER TO zeteo_owner;
