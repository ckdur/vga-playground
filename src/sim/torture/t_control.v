// Torture: control flow. case/casez, for/while/repeat loops in
// combinational logic, functions with loops and early values, tasks,
// priority encoders and nested conditionals.
module t_control (
    input  wire        clk,
    input  wire        rst_n,
    input  wire [63:0] a,
    input  wire [63:0] b,
    input  wire [ 7:0] c,
    output reg  [ 6:0] popcount,
    output reg  [ 5:0] lzc,
    output reg  [ 7:0] casez_out,
    output reg  [15:0] bitrev,
    output reg  [31:0] fsm_out,
    output reg  [ 2:0] state,
    output reg  [15:0] gcd_out,
    output reg  [31:0] while_out,
    output reg  [ 7:0] task_out,
    output reg  [ 7:0] comb_sel
);

  function automatic [6:0] popcnt(input [63:0] v);
    integer k;
    begin
      popcnt = 0;
      for (k = 0; k < 64; k = k + 1) popcnt = popcnt + {6'd0, v[k]};
    end
  endfunction

  function automatic [5:0] clz(input [31:0] v);
    integer k;
    reg found;
    begin
      clz = 6'd32;
      found = 0;
      for (k = 31; k >= 0; k = k - 1) begin
        if (!found && v[k]) begin
          clz = 6'(31 - k);
          found = 1;
        end
      end
    end
  endfunction

  function automatic [15:0] gcd(input [15:0] x, input [15:0] y);
    reg [15:0] p, q, t;
    integer guard;
    begin
      p = x;
      q = y;
      guard = 0;
      while (q != 0 && guard < 40) begin
        t = p % q;
        p = q;
        q = t;
        guard = guard + 1;
      end
      gcd = p;
    end
  endfunction

  task automatic mix(input [7:0] x, input [7:0] y, output [7:0] z);
    begin
      z = {x[3:0], y[7:4]} ^ 8'h5a;
      repeat (3) z = {z[6:0], z[7] ^ z[5]};
    end
  endtask

  integer j;
  reg [7:0] tmp;
  reg [31:0] wacc;

  always @(*) begin
    casez (c)
      8'b1???_????: comb_sel = 8'd7;
      8'b01??_????: comb_sel = 8'd6;
      8'b001?_????: comb_sel = 8'd5;
      8'b0001_????: comb_sel = 8'd4;
      8'b0000_1???: comb_sel = 8'd3;
      8'b0000_01??: comb_sel = 8'd2;
      8'b0000_001?: comb_sel = 8'd1;
      default:      comb_sel = 8'd0;
    endcase
  end

  always @(posedge clk) begin
    if (!rst_n) begin
      popcount <= 0;
      lzc <= 0;
      casez_out <= 0;
      bitrev <= 0;
      fsm_out <= 0;
      state <= 0;
      gcd_out <= 0;
      while_out <= 0;
      task_out <= 0;
    end else begin
      popcount <= popcnt(a ^ b);
      lzc <= clz(a[31:0] >> c[4:0]);
      case (c[2:0])
        3'd0: casez_out <= a[7:0];
        3'd1: casez_out <= b[7:0];
        3'd2, 3'd3: casez_out <= a[7:0] & b[7:0];
        3'd4: casez_out <= ~c;
        default: casez_out <= {c[3:0], c[7:4]};
      endcase
      for (j = 0; j < 16; j = j + 1) bitrev[j] <= a[15-j];
      case (state)
        3'd0: begin
          fsm_out <= fsm_out + 1;
          if (a[0]) state <= 3'd1;
        end
        3'd1: begin
          fsm_out <= fsm_out ^ b[31:0];
          state <= b[1] ? 3'd2 : 3'd0;
        end
        3'd2: begin
          fsm_out <= {fsm_out[30:0], fsm_out[31]};
          state <= 3'd3;
        end
        3'd3: begin
          if (c > 8'd128) state <= 3'd4;
          else state <= 3'd0;
        end
        default: begin
          fsm_out <= 0;
          state <= 3'd0;
        end
      endcase
      gcd_out <= gcd(a[15:0] | 16'd1, b[15:0]);
      wacc = 0;
      j = 0;
      while (j < {24'd0, c[3:0]}) begin
        wacc = wacc * 3 + {24'd0, c} + j;
        j = j + 1;
      end
      while_out <= wacc;
      mix(a[7:0], b[7:0], tmp);
      task_out <= tmp;
    end
  end

endmodule
