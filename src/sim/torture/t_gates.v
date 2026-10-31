// Torture: gate-level style netlists, like the ones produced by synthesis
// and place & route. Combinational and sequential UDPs, built-in gate
// primitives, hierarchy of cells and power pins, in the style of the
// sky130 standard cell library.
`timescale 1ns / 1ps

primitive t_udp_mux2 (out, a0, a1, s);
  output out;
  input a0, a1, s;
  table
  // a0 a1 s : out
     0  ?  0 : 0;
     1  ?  0 : 1;
     ?  0  1 : 0;
     ?  1  1 : 1;
     0  0  ? : 0;
     1  1  ? : 1;
  endtable
endprimitive

primitive t_udp_dff (q, d, clk);
  output q;
  reg q;
  input d, clk;
  table
  // d clk : q : q+
     0 (01) : ? : 0;
     1 (01) : ? : 1;
     ? (?0) : ? : -;
     * ?    : ? : -;
  endtable
endprimitive

module t_cell_mux2 (
    output X,
    input  A0,
    input  A1,
    input  S,
    inout  VPWR,
    inout  VGND
);
  wire mux_out;
  t_udp_mux2 u0 (mux_out, A0, A1, S);
  buf b0 (X, mux_out);
endmodule

module t_cell_dfxtp (
    output Q,
    input  CLK,
    input  D,
    inout  VPWR,
    inout  VGND
);
  wire buf_Q;
  t_udp_dff d0 (buf_Q, D, CLK);
  buf b0 (Q, buf_Q);
endmodule

module t_cell_a21oi (
    output Y,
    input  A1,
    input  A2,
    input  B1,
    inout  VPWR,
    inout  VGND
);
  wire and0_out, nor0_out_Y;
  and and0 (and0_out, A1, A2);
  nor nor0 (nor0_out_Y, B1, and0_out);
  buf buf0 (Y, nor0_out_Y);
endmodule

module t_cell_xor2 (
    output X,
    input  A,
    input  B,
    inout  VPWR,
    inout  VGND
);
  wire xor0_out;
  xor xor0 (xor0_out, B, A);
  buf buf0 (X, xor0_out);
endmodule

module t_cell_conb (
    output HI,
    output LO,
    inout  VPWR,
    inout  VGND
);
  pullup pu (HI);
  pulldown pd (LO);
endmodule

// A synthesized-looking 4-bit counter with load/enable plus a 4-bit LFSR.
module t_gates (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [63:0] a,
    input  wire [63:0] b,
    input  wire [ 7:0] c,
    output wire [ 3:0] cnt,
    output wire [ 3:0] lfsr,
    output wire [ 1:0] ties,
    output wire [ 3:0] comb
);
  wire VPWR = 1'b1;
  wire VGND = 1'b0;

  wire [3:0] inc;
  wire [3:0] next;
  wire [3:0] lnext;
  wire [3:0] carry;
  wire tie_hi, tie_lo;

  t_cell_conb tie (
      .HI(tie_hi),
      .LO(tie_lo),
      .VPWR(VPWR),
      .VGND(VGND)
  );
  assign ties = {tie_hi, tie_lo};

  // ripple incrementer from xor + and
  assign carry[0] = 1'b1;
  genvar i;
  generate
    for (i = 0; i < 4; i = i + 1) begin : bit_
      t_cell_xor2 x (
          .X(inc[i]),
          .A(cnt[i]),
          .B(carry[i]),
          .VPWR(VPWR),
          .VGND(VGND)
      );
      if (i < 3) begin : c_
        and a_ (carry[i+1], cnt[i], carry[i]);
      end
      // next = rst ? 0 : (load ? c : inc)
      wire load_mux;
      t_cell_mux2 m0 (
          .X(load_mux),
          .A0(inc[i]),
          .A1(c[i]),
          .S(c[7]),
          .VPWR(VPWR),
          .VGND(VGND)
      );
      and r0 (next[i], load_mux, rst_n);
      t_cell_dfxtp ff (
          .Q(cnt[i]),
          .CLK(clk),
          .D(next[i]),
          .VPWR(VPWR),
          .VGND(VGND)
      );

      t_cell_dfxtp lf (
          .Q(lfsr[i]),
          .CLK(clk),
          .D(lnext[i]),
          .VPWR(VPWR),
          .VGND(VGND)
      );
    end
  endgenerate

  // lfsr: x^4 + x^3 + 1, reset to 4'b0001
  wire fb;
  xnor xn (fb, lfsr[3], lfsr[2]);
  wire nfb;
  not n0 (nfb, fb);
  t_cell_mux2 l0 (
      .X(lnext[0]),
      .A0(1'b1),
      .A1(nfb),
      .S(rst_n),
      .VPWR(VPWR),
      .VGND(VGND)
  );
  and l1 (lnext[1], lfsr[0], rst_n);
  and l2 (lnext[2], lfsr[1], rst_n);
  and l3 (lnext[3], lfsr[2], rst_n);

  // a21oi / combinational cells
  t_cell_a21oi g0 (
      .Y(comb[0]),
      .A1(a[0]),
      .A2(a[1]),
      .B1(b[0]),
      .VPWR(VPWR),
      .VGND(VGND)
  );
  t_cell_a21oi g1 (
      .Y(comb[1]),
      .A1(a[2]),
      .A2(b[2]),
      .B1(c[0]),
      .VPWR(VPWR),
      .VGND(VGND)
  );
  nand g2 (comb[2], a[3], b[3], c[3]);
  or g3 (comb[3], a[4], b[4], cnt[0]);

endmodule
