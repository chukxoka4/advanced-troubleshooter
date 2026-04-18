package sample

type Point struct {
	X float64
	Y float64
}

func Distance(a Point, b Point) float64 {
	dx := a.X - b.X
	dy := a.Y - b.Y
	return dx*dx + dy*dy
}

type Vec struct {
	X float64
	Y float64
}

func (v Vec) Length() float64 {
	return v.X*v.X + v.Y*v.Y
}
